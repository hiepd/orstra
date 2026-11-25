import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Store } from '../src/db.ts';
import { Runner } from '../src/runner.ts';
import { startServer } from '../src/server.ts';
import { gitInfo } from '../src/git.ts';
import type { Executors, GateRequest, LiveSession, SessionOptions } from '../src/executors.ts';
import { cleanRelative, createWorkspace, deleteWorkspace, pickWorkspace, taskCwd, updateWorkspace, workspaceView } from '../src/workspace.ts';
import { Terminals } from '../src/terminals.ts';

const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();

/** A repo with 2 branches: main (1 commit) and feature (1 more), checked out on feature. */
function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'orstra-ws-repo-'));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@t');
  git(repo, 'config', 'user.name', 't');
  mkdirSync(join(repo, 'apps/web'), { recursive: true });
  writeFileSync(join(repo, 'apps/web/index.ts'), 'x\n');
  writeFileSync(join(repo, '.gitignore'), '.env.local\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'first');
  git(repo, 'checkout', '-q', '-b', 'feature');
  writeFileSync(join(repo, 'feature.txt'), 'f\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'feature');
  writeFileSync(join(repo, '.env.local'), 'SECRET=1\n');
  return repo;
}

/** The real worktree command, under a temp folder instead of ~/.orstra/wt. */
function tempWorktrees() {
  const root = mkdtempSync(join(tmpdir(), 'orstra-ws-wt-'));
  return (taskId: string, repo?: string, base?: string) => {
    const dir = join(root, taskId);
    if (repo) git(repo, 'worktree', 'add', '-q', dir, '-b', `orstra/${taskId}`, ...(base ? [base] : []));
    else {
      mkdirSync(dir, { recursive: true });
      git(dir, 'init', '-q', '-b', 'main');
    }
    return dir;
  };
}

/** Executors that record what each session and gate got, and finish every agent turn with `done`. */
function recorder(gatePass: (cmds: string[]) => boolean = () => true) {
  const sessions: SessionOptions[] = [];
  const gates: GateRequest[] = [];
  const exec: Executors = {
    session(_kind, opts): LiveSession {
      sessions.push(opts);
      let done!: (r: { ok: boolean }) => void;
      const closed = new Promise<{ ok: boolean }>((r) => (done = r));
      return {
        send() { setTimeout(() => opts.onTurn({ text: 'ok\nOUTCOME: done', interrupted: false, isError: false }), 1); },
        interrupt() {},
        end() { done({ ok: true }); },
        kill() { done({ ok: true }); },
        closed,
      };
    },
    async gate(req) {
      gates.push(req);
      const pass = gatePass(req.commands);
      return { pass, output: pass ? 'ok' : 'npm ERR! missing script' };
    },
    async ask() { return ''; },
  };
  return { exec, sessions, gates };
}

const ONE_AGENT = 'name: Do\nsteps:\n  work:\n    use: agent\n    prompt: Do it\n    next: end\n';
const AGENT_THEN_GATE = 'name: Check\nsteps:\n  work:\n    use: agent\n    prompt: Do it\n    next: test\n  test:\n    use: gate\n    run: [npm test]\n    next: end\n';

function workflowFile(yaml: string): string {
  const p = join(mkdtempSync(join(tmpdir(), 'orstra-ws-wf-')), 'wf.yaml');
  writeFileSync(p, yaml);
  return p;
}

const waitFor = async (ok: () => boolean) => {
  for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 5));
};

describe('workspace rules', () => {
  it('reads the base branch from the repo, and refuses a folder that is not a git repo', () => {
    const store = new Store(':memory:');
    const repo = makeRepo();
    const w = createWorkspace(store, { name: 'hub', repoPath: repo });
    expect(w.base_branch).toBe('feature'); // no origin, so the checked-out branch
    expect(() => createWorkspace(store, { name: 'empty', repoPath: mkdtempSync(join(tmpdir(), 'orstra-ws-none-')) })).toThrow(/not a git repository/);
  });

  it('refuses a base branch, a sub-directory or a name that does not fit', () => {
    const store = new Store(':memory:');
    const repo = makeRepo();
    createWorkspace(store, { name: 'hub', repoPath: repo });
    expect(() => createWorkspace(store, { name: 'HUB', repoPath: repo })).toThrow(/already exists/);
    expect(() => createWorkspace(store, { name: 'b', repoPath: repo, baseBranch: 'nope' })).toThrow(/no branch called nope/);
    expect(() => createWorkspace(store, { name: 'c', repoPath: repo, subdir: 'apps/missing' })).toThrow(/no folder called apps\/missing/);
    expect(() => createWorkspace(store, { name: 'd', repoPath: repo, subdir: '../elsewhere' })).toThrow(/inside the repo/);
    expect(() => createWorkspace(store, { name: 'e', repoPath: repo, env: { 'BAD NAME': '1' } })).toThrow(/not a valid environment variable/);
  });

  it('keeps sub-directories and files to copy relative to the repo root', () => {
    expect(cleanRelative('./apps/web/', 'x')).toBe('apps/web');
    expect(cleanRelative('.', 'x')).toBe('');
    expect(() => cleanRelative('/etc', 'x')).toThrow();
  });

  it('changes a workspace field by field, and unlinks its tasks when it is removed', () => {
    const store = new Store(':memory:');
    const repo = makeRepo();
    const w = createWorkspace(store, { name: 'hub', repoPath: repo, baseBranch: 'main' });
    const changed = updateWorkspace(store, w.id, { subdir: 'apps/web', setup: [' npm ci ', ''] });
    expect(workspaceView(changed)).toMatchObject({ name: 'hub', baseBranch: 'main', subdir: 'apps/web', setup: ['npm ci'] });
    const runner = new Runner(store, recorder().exec, { slots: 1, createWorktree: tempWorktrees() });
    const t = runner.startTask({ workflowPath: workflowFile('name: H\nsteps:\n  a:\n    use: human\n    question: ok?\n    on: { approved: end }\n'), title: 'x', workspaceId: w.id });
    expect(deleteWorkspace(store, w.id)).toBe(1);
    expect(store.task(t.id)!.workspace_id).toBeNull();
    expect(store.task(t.id)!.worktree).toBe(t.worktree); // the work stays
  });

  it('picks the workspace a task gets, or refuses and says which ones exist', () => {
    const store = new Store(':memory:');
    const row = (id: string, name: string) => ({ id, name, repo_path: '/r', base_branch: 'main', subdir: '', default_workflow: null, setup: '[]', copy_files: '[]', env: '{}', created_at: 0, updated_at: 0 });
    expect(() => pickWorkspace(store, {})).toThrow(/needs a workspace/);
    expect(pickWorkspace(store, { repo: '~/code/x' })).toBeNull(); // a repo path used once
    store.insertWorkspace(row('w-a', 'orstra'));
    expect(pickWorkspace(store, {})!.id).toBe('w-a'); // the only one
    store.insertWorkspace(row('w-b', 'forge'));
    expect(() => pickWorkspace(store, {})).toThrow('Pick one of: forge, orstra.');
    expect(pickWorkspace(store, { workspace: 'FORGE' })!.id).toBe('w-b');
    expect(pickWorkspace(store, { workspace: 'w-a' })!.id).toBe('w-a');
    expect(() => pickWorkspace(store, { workspace: 'nope' })).toThrow(/no workspace called nope/);
  });
});

describe('a task in a workspace', () => {
  it('starts its branch from the base branch, not from what the repo has checked out', () => {
    const store = new Store(':memory:');
    const repo = makeRepo();
    const w = createWorkspace(store, { name: 'hub', repoPath: repo, baseBranch: 'main' });
    const runner = new Runner(store, recorder().exec, { slots: 1, createWorktree: tempWorktrees() });
    const t = runner.startTask({ workflowPath: workflowFile('name: H\nsteps:\n  a:\n    use: human\n    question: ok?\n    on: { approved: end }\n'), title: 'x', workspaceId: w.id });
    const row = store.task(t.id)!;
    expect(row.workspace_id).toBe(w.id);
    expect(row.base_branch).toBe('main');
    expect(row.base_commit).toBe(git(repo, 'rev-parse', 'main'));
    expect(existsSync(join(row.worktree!, 'feature.txt'))).toBe(false);
  });

  it('lets a task start from another branch than the workspace default', () => {
    const store = new Store(':memory:');
    const repo = makeRepo();
    const w = createWorkspace(store, { name: 'hub', repoPath: repo, baseBranch: 'main' });
    const runner = new Runner(store, recorder().exec, { slots: 1, createWorktree: tempWorktrees() });
    const t = runner.startTask({ workflowPath: workflowFile('name: H\nsteps:\n  a:\n    use: human\n    question: ok?\n    on: { approved: end }\n'), title: 'x', workspaceId: w.id, baseBranch: 'feature' });
    expect(store.task(t.id)!.base_branch).toBe('feature');
    expect(existsSync(join(t.worktree!, 'feature.txt'))).toBe(true);
  });

  it('copies the gitignored files the workspace names, and says which ones the repo lacks', () => {
    const store = new Store(':memory:');
    const repo = makeRepo();
    const w = createWorkspace(store, { name: 'hub', repoPath: repo, copyFiles: ['.env.local', '.env.test'] });
    const runner = new Runner(store, recorder().exec, { slots: 1, createWorktree: tempWorktrees() });
    const t = runner.startTask({ workflowPath: workflowFile('name: H\nsteps:\n  a:\n    use: human\n    question: ok?\n    on: { approved: end }\n'), title: 'x', workspaceId: w.id });
    expect(readFileSync(join(t.worktree!, '.env.local'), 'utf8')).toBe('SECRET=1\n');
    const said = store.events(t.id).map((e) => JSON.parse(e.payload).text).join('\n');
    expect(said).toContain('Copied .env.local into the worktree.');
    expect(said).toContain('The repo has no .env.test');
  });

  it('starts agents and gates in the sub-directory, with the workspace environment', async () => {
    const store = new Store(':memory:');
    const repo = makeRepo();
    const w = createWorkspace(store, { name: 'hub', repoPath: repo, baseBranch: 'main', subdir: 'apps/web', env: { PORT: '5317' } });
    const rec = recorder();
    const runner = new Runner(store, rec.exec, { slots: 1, createWorktree: tempWorktrees(), turnGraceMs: 0 });
    const t = runner.startTask({ workflowPath: workflowFile(AGENT_THEN_GATE), title: 'x', workspaceId: w.id });
    await waitFor(() => rec.gates.length > 0);
    expect(rec.sessions[0].cwd).toBe(join(t.worktree!, 'apps/web'));
    expect(rec.sessions[0].env).toEqual({ PORT: '5317' });
    expect(rec.gates[0].cwd).toBe(join(t.worktree!, 'apps/web'));
    expect(rec.gates[0].env).toEqual({ PORT: '5317' });
    expect(taskCwd(store.task(t.id)!)).toBe(join(t.worktree!, 'apps/web'));
  });

  it('runs the setup once, before the first agent step', async () => {
    const store = new Store(':memory:');
    const repo = makeRepo();
    const w = createWorkspace(store, { name: 'hub', repoPath: repo, setup: ['npm ci'] });
    const rec = recorder();
    const runner = new Runner(store, rec.exec, { slots: 1, createWorktree: tempWorktrees(), turnGraceMs: 0 });
    const t = runner.startTask({ workflowPath: workflowFile(AGENT_THEN_GATE), title: 'x', workspaceId: w.id });
    await waitFor(() => rec.gates.length >= 2);
    expect(rec.gates.map((g) => g.commands)).toEqual([['npm ci'], ['npm test']]);
    expect(store.task(t.id)!.setup_at).not.toBeNull();
    expect(rec.sessions).toHaveLength(1);
  });

  it('sends the task to the Inbox when the setup fails, and starts no agent', async () => {
    const store = new Store(':memory:');
    const repo = makeRepo();
    const w = createWorkspace(store, { name: 'hub', repoPath: repo, setup: ['npm ci'] });
    const rec = recorder((cmds) => cmds[0] !== 'npm ci');
    const runner = new Runner(store, rec.exec, { slots: 1, createWorktree: tempWorktrees(), turnGraceMs: 0 });
    const t = runner.startTask({ workflowPath: workflowFile(ONE_AGENT), title: 'x', workspaceId: w.id });
    await waitFor(() => store.task(t.id)!.status === 'needs_you');
    expect(store.task(t.id)!.status).toBe('needs_you');
    expect(store.runsForTask(t.id)[0]).toMatchObject({ outcome: 'setup_failed', output: 'npm ERR! missing script' });
    expect(store.task(t.id)!.setup_at).toBeNull();
    expect(rec.sessions).toHaveLength(0);
  });

  it('compares the work with the commit it started from, even after the checkout moves', () => {
    const store = new Store(':memory:');
    const repo = makeRepo();
    const w = createWorkspace(store, { name: 'hub', repoPath: repo, baseBranch: 'main' });
    const runner = new Runner(store, recorder().exec, { slots: 1, createWorktree: tempWorktrees() });
    const t = runner.startTask({ workflowPath: workflowFile('name: H\nsteps:\n  a:\n    use: human\n    question: ok?\n    on: { approved: end }\n'), title: 'x', workspaceId: w.id });
    const row = store.task(t.id)!;
    // The main checkout stays on feature, 1 commit past main. A merge-base read would say feature.
    const info = gitInfo(row.worktree!, { branch: row.base_branch!, commit: row.base_commit! })!;
    expect(info.base).toBe('main');
    expect(info.ahead).toBe(0);
    expect(info.files).toEqual([]);
  });
});

describe('workspace API', () => {
  let server: Server;
  let base: string;
  let store: Store;
  let wf: string;
  const json = { 'content-type': 'application/json' };
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, { method, headers: json, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as any };
  };

  beforeAll(async () => {
    wf = workflowFile('name: H\nsteps:\n  a:\n    use: human\n    question: ok?\n    on: { approved: end }\n');
    store = new Store(':memory:');
    const runner = new Runner(store, recorder().exec, { slots: 1, createWorktree: tempWorktrees() });
    server = startServer(store, runner, 0, undefined, undefined, { terminals: new Terminals({ shell: '/bin/sh', args: [] }) });
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  it('refuses a task with no workspace and no repo path', async () => {
    const res = await call('POST', '/api/tasks', { workflow: wf, title: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/needs a workspace/);
  });

  it('creates a workspace, checks a repo path, and starts a task in it', async () => {
    const repo = makeRepo();
    expect((await call('GET', `/api/workspaces/check?repo=${encodeURIComponent(repo)}`)).body).toEqual({ ok: true, baseBranch: 'feature' });
    expect((await call('GET', '/api/workspaces/check?repo=/nowhere')).body.ok).toBe(false);
    const made = await call('POST', '/api/workspaces', { name: 'hub', repoPath: repo, baseBranch: 'main' });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ name: 'hub', baseBranch: 'main', setup: [], copyFiles: [], env: {} });
    const started = await call('POST', '/api/tasks', { workflow: wf, title: 'x' }); // the only workspace
    expect(started.status).toBe(201);
    expect(started.body.workspace).toEqual({ id: made.body.id, name: 'hub' });
    const detail = await call('GET', `/api/tasks/${started.body.id}`);
    expect(detail.body).toMatchObject({ baseBranch: 'main', baseCommit: git(repo, 'rev-parse', 'main') });
    const patched = await call('PATCH', `/api/workspaces/${made.body.id}`, { subdir: 'apps/web' });
    expect(patched.body.subdir).toBe('apps/web');
    expect((await call('PATCH', `/api/workspaces/${made.body.id}`, { subdir: 'nope' })).status).toBe(400);
    expect((await call('GET', '/api/workspaces')).body).toHaveLength(1);
    expect((await call('DELETE', `/api/workspaces/${made.body.id}`)).body).toEqual({ ok: true, unlinked: 1 });
  });
});
