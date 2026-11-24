import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Store } from '../src/db.ts';
import { Runner } from '../src/runner.ts';
import { startServer } from '../src/server.ts';
import type { Executors } from '../src/executors.ts';

let server: Server;
let base: string;
let store: Store;
let runner: Runner;
let taskId: string;
const json = { 'content-type': 'application/json' };

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orstra-srv-'));
  const wf = join(dir, 'wf.yaml');
  writeFileSync(wf, 'name: X\nsteps:\n  review:\n    use: human\n    question: ok?\n    on: { approved: end }\n');
  store = new Store(':memory:');
  runner = new Runner(store, {} as Executors, { slots: 1, createWorktree: () => dir });
  taskId = runner.startTask({ workflowPath: wf, title: 'x' }).id;
  server = startServer(store, runner, 0);
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
