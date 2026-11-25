import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Store } from '../src/db.ts';
import { Runner } from '../src/runner.ts';
import { startServer } from '../src/server.ts';
import type { Executors } from '../src/executors.ts';
import { Terminals } from '../src/terminals.ts';

let server: Server;
let base: string;
let store: Store;
let runner: Runner;
let taskId: string;
let dir: string;
const json = { 'content-type': 'application/json' };

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'orstra-srv-'));
  const wf = join(dir, 'wf.yaml');
  writeFileSync(wf, 'name: X\nsteps:\n  review:\n    use: human\n    question: ok?\n    on: { approved: end }\n');
  store = new Store(':memory:');
  runner = new Runner(store, {} as Executors, { slots: 1, createWorktree: () => dir });
  taskId = runner.startTask({ workflowPath: wf, title: 'x' }).id;
  server = startServer(store, runner, 0, undefined, undefined, { terminals: new Terminals({ shell: '/bin/sh', args: [] }) });
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

const get = async (path: string) => (await fetch(base + path)).json() as Promise<any>;
const post = async (path: string, body: unknown = {}) => fetch(base + path, { method: 'POST', headers: json, body: JSON.stringify(body) });

describe('task API', () => {
  it('sends only the events after the one the UI has', async () => {
    const all = await get(`/api/tasks/${taskId}`);
    expect(all.events.length).toBeGreaterThan(0);
    const lastId = all.events.at(-1).id;
    store.addEvent(taskId, null, 'system', { text: 'new line' });
    const fresh = await get(`/api/tasks/${taskId}?after=${lastId}`);
    expect(fresh.eventsAfter).toBe(lastId);
    expect(fresh.events.map((e: any) => e.text)).toEqual(['new line']);
  });

  it('sends the Inbox no events, but the last system line', async () => {
    const inbox = await get('/api/inbox');
    expect(inbox).toHaveLength(1);
    expect(inbox[0].events).toEqual([]);
    expect(inbox[0].lastSystem).toBe('new line');
    expect(inbox[0].cost).toEqual({ usd: 0, tokensIn: 0, tokensOut: 0 });
  });

  it('archives a finished task out of the list', async () => {
    const run = store.runsForTask(taskId)[0];
    expect((await post(`/api/runs/${run.id}/decide`, { choice: 'approved' })).status).toBe(200);
    expect((await post(`/api/tasks/${taskId}/archive`)).status).toBe(200);
    expect(await get('/api/tasks')).toHaveLength(0);
    expect(await get('/api/tasks?archived=1')).toHaveLength(1);
  });
});

describe('worktree files', () => {
  it('sends a file in the worktree with headers that keep it inert', async () => {
    writeFileSync(join(dir, 'note.md'), '# Note\n');
    const r = await fetch(`${base}/api/tasks/${taskId}/file?path=note.md`);
    expect(r.status).toBe(200);
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('content-security-policy')).toContain('sandbox');
    expect(await r.text()).toBe('# Note\n');
  });

  it('answers 404 for a path out of the worktree', async () => {
    expect((await fetch(`${base}/api/tasks/${taskId}/file?path=..%2Fwf.yaml`)).status).toBe(404);
    expect((await fetch(`${base}/api/tasks/nope/file?path=note.md`)).status).toBe(404);
  });
});

describe('link info', () => {
  it('refuses a link that is not http or https', async () => {
    const r = await fetch(`${base}/api/link-info?url=${encodeURIComponent('file:///etc/hosts')}`);
    expect(r.status).toBe(400);
  });
});

describe('terminals', () => {
  it('opens a shell in the worktree, streams its output and takes keys', async () => {
    const r = await post(`/api/tasks/${taskId}/terminals`);
    expect(r.status).toBe(201);
    const t = await r.json();
    expect((await get(`/api/tasks/${taskId}/terminals`)).map((x: any) => x.id)).toEqual([t.id]);
    const ctrl = new AbortController();
    const stream = await fetch(`${base}/api/terminals/${t.id}/stream`, { signal: ctrl.signal });
    expect(stream.headers.get('content-type')).toBe('text/event-stream');
    const reader = stream.body!.getReader();
    expect((await post(`/api/terminals/${t.id}/input`, { data: 'echo ok-$((40+2))\n' })).status).toBe(200);
    let text = '';
    while (!text.includes('ok-42')) text += new TextDecoder().decode((await reader.read()).value);
    expect(text).toContain('"type":"data"');
    ctrl.abort();
    expect((await post(`/api/terminals/${t.id}/close`)).status).toBe(200);
  });

  it('answers 404 for a terminal that is not there', async () => {
    expect((await fetch(`${base}/api/terminals/nope/stream`)).status).toBe(404);
    expect((await post('/api/terminals/nope/input', { data: 'x' })).status).toBe(404);
  });
});

describe('dev server', () => {
  it('starts a command in the worktree and stops it', async () => {
    expect(await get(`/api/tasks/${taskId}/devserver`)).toMatchObject({ state: 'stopped', url: null });
    const cmd = `node -e "console.log('http://localhost:'+process.env.PORT); setInterval(()=>{},1000)"`;
    const r = await post(`/api/tasks/${taskId}/devserver/start`, { command: cmd });
    expect(r.status).toBe(200);
    expect((await r.json()).state).toBe('starting');
    let v: any;
    for (let i = 0; i < 200 && v?.state !== 'running'; i++) {
      v = await get(`/api/tasks/${taskId}/devserver`);
      await new Promise((ok) => setTimeout(ok, 25));
    }
    expect(v.url).toMatch(/^http:\/\/localhost:\d+$/);
    expect((await post(`/api/tasks/${taskId}/devserver/stop`)).status).toBe(200);
    expect((await get(`/api/tasks/${taskId}/devserver`)).state).toBe('stopped');
  });

  it('refuses a start with no command and no package.json', async () => {
    const r = await post(`/api/tasks/${taskId}/devserver/start`, {});
    expect(r.status).toBe(400);
  });
});

describe('cleanup', () => {
  it('sends no cleanup event when the cleanup refuses, so your shells keep running', () => {
    const id = runner.startTask({ workflowPath: join(dir, 'wf.yaml'), title: 'y' }).id;
    store.updateTask(id, { status: 'done' });
    const seen: string[] = [];
    runner.on('cleanup', (t: string) => seen.push(t));
    // The test folder is not a git repository, so a cleanup without force refuses.
    expect(() => runner.cleanup(id)).toThrow(/not a git repository/);
    expect(seen).toEqual([]);
  });

  it('sends the cleanup event just before the worktree goes', () => {
    const own = mkdtempSync(join(tmpdir(), 'orstra-clean-'));
    const r = new Runner(new Store(':memory:'), {} as Executors, { slots: 1, createWorktree: () => own });
    writeFileSync(join(own, 'wf.yaml'), 'name: X\nsteps:\n  review:\n    use: human\n    question: ok?\n    on: { approved: end }\n');
    const id = r.startTask({ workflowPath: join(own, 'wf.yaml'), title: 'z' }).id;
    (r as any).store.updateTask(id, { status: 'done' });
    const seen: boolean[] = [];
    r.on('cleanup', () => seen.push(existsSync(own)));
    r.cleanup(id, { force: true });
    expect(seen).toEqual([true]);
    expect(existsSync(own)).toBe(false);
  });
});

describe('worktree files the agent wrote elsewhere', () => {
  it('serves a file from a repository the task\'s agent edited in, and nothing else there', async () => {
    const other = mkdtempSync(join(tmpdir(), 'orstra-elsewhere-'));
    execFileSync('git', ['init', '-q'], { cwd: other });
    writeFileSync(join(other, 'design.md'), '# Design\n');
    expect((await fetch(`${base}/api/tasks/${taskId}/file?path=design.md`)).status).toBe(404);
    store.addEvent(taskId, null, 'tool', { name: 'Write', summary: join(other, 'design.md') });
    const r = await fetch(`${base}/api/tasks/${taskId}/file?path=design.md`);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('# Design\n');
    expect((await fetch(`${base}/api/tasks/${taskId}/file?path=${encodeURIComponent('/etc/hosts')}`)).status).toBe(404);
  });
});

describe('the repository the agent used last wins', () => {
  it('reads a path from the newest repository when 2 have it', async () => {
    const mk = (text: string) => {
      const d = mkdtempSync(join(tmpdir(), 'orstra-repo-'));
      execFileSync('git', ['init', '-q'], { cwd: d });
      writeFileSync(join(d, 'same.md'), text);
      return d;
    };
    const older = mk('old\n');
    const newer = mk('new\n');
    store.addEvent(taskId, null, 'tool', { name: 'Read', summary: join(older, 'same.md') });
    store.addEvent(taskId, null, 'tool', { name: 'Edit', summary: join(newer, 'same.md') });
    expect(await (await fetch(`${base}/api/tasks/${taskId}/file?path=same.md`)).text()).toBe('new\n');
  });
});

describe('task start with an idempotency key', () => {
  it('starts the task once, and answers the second start with the same task', async () => {
    const body = { workflow: join(dir, 'wf.yaml'), repo: dir, title: 'from a trigger', idempotencyKey: 'ci:build-41' };
    const first = await post('/api/tasks', body);
    expect(first.status).toBe(201);
    const a = (await first.json()) as any;
    expect(a.reused).toBe(false);
    const second = await post('/api/tasks', { ...body, title: 'a second try' });
    expect(second.status).toBe(200);
    const b = (await second.json()) as any;
    expect(b).toMatchObject({ id: a.id, reused: true, title: 'from a trigger' });
    expect(store.tasks().filter((t) => t.idempotency_key === 'ci:build-41')).toHaveLength(1);
  });
});

describe('the callback URL of a wait step', () => {
  it('completes the run on a POST, and refuses a second one and an unknown URL', async () => {
    const wf = join(dir, 'cb.yaml');
    writeFileSync(wf, 'name: CB\nsteps:\n  ci:\n    use: wait\n    callback: true\n    next: end\n');
    const task = runner.startTask({ workflowPath: wf, title: 'waits for CI' });
    await new Promise((r) => setTimeout(r, 20));
    const secret = store.runsForTask(task.id)[0].callback_secret!;
    const ok = await post(`/api/callbacks/${secret}`, { outcome: 'done', data: { build: 41 } });
    expect(ok.status).toBe(200);
    expect(store.task(task.id)!.status).toBe('done');
    expect(JSON.parse(store.runsForTask(task.id)[0].data!)).toEqual({ build: 41 });
    expect((await post(`/api/callbacks/${secret}`)).status).toBe(409);
    expect((await post(`/api/callbacks/${'a'.repeat(48)}`)).status).toBe(404);
  });
});
