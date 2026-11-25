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

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orstra-ev-'));
  const wf = join(dir, 'wf.yaml');
  writeFileSync(wf, 'name: X\nsteps:\n  review:\n    use: human\n    question: ok?\n    on: { approved: end }\n');
  store = new Store(':memory:');
  runner = new Runner(store, {} as Executors, { slots: 1, createWorktree: () => dir });
  taskId = runner.startTask({ workflowPath: wf, title: 'x' }).id;
  // A short beat so the test does not wait for the real one.
  server = startServer(store, runner, 0, undefined, undefined, { heartbeatMs: 60 });
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

/** Opens the stream and reads it until `want` lines arrive or the time runs out. */
async function read(want: (text: string) => boolean, ms = 3000): Promise<string> {
  const ctrl = new AbortController();
  const res = await fetch(`${base}/api/events`, { signal: ctrl.signal });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const stop = setTimeout(() => ctrl.abort(), ms);
  try {
    while (!want(text)) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } catch {
    /* aborted: return what arrived */
  } finally {
    clearTimeout(stop);
    ctrl.abort();
  }
  return text;
}

describe('/api/events', () => {
  it('sends a beat while nothing changes, so a dead stream can be told from a quiet one', async () => {
    const text = await read((t) => (t.match(/event: ping/g) ?? []).length >= 2);
    expect((text.match(/event: ping/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('names the beat, so the UI does not refetch for it', async () => {
    const text = await read((t) => t.includes('event: ping'));
    // Every data line of an unnamed message tells the UI to refetch. The beat must not be one.
    const lines = text.split('\n').filter((l) => l.startsWith('data:'));
    const named = text.split('\n\n').filter((b) => b.includes('event: ping'));
    expect(named.length).toBeGreaterThan(0);
    for (const l of lines) expect(JSON.parse(l.slice(5)).ping).toBe(true);
  });

  it('still sends a change as an unnamed message', async () => {
    const got = read((t) => t.includes('"taskId"'));
    await new Promise((r) => setTimeout(r, 50));
    await runner.message(taskId, 'hello', 'note');
    const text = await got;
    const block = text.split('\n\n').find((b) => b.includes('"taskId"'))!;
    expect(block).toContain(`"taskId":"${taskId}"`);
    expect(block).not.toContain('event:');
  });

  it('sends the text an agent writes as a named draft event, the newest one per run', async () => {
    const got = read((t) => t.includes('Hello world'));
    await new Promise((r) => setTimeout(r, 50));
    for (const text of ['Hel', 'Hello', 'Hello wor', 'Hello world']) runner.emit('draft', { taskId, runId: 'r-1', text, after: 7 });
    const text = await got;
    const drafts = text.split('\n\n').filter((b) => b.includes('event: draft'));
    // A burst sends the newest draft, not each chunk.
    expect(drafts).toHaveLength(1);
    expect(JSON.parse(drafts[0].split('data: ')[1])).toEqual({ taskId, runId: 'r-1', text: 'Hello world', after: 7 });
  });

  it('keeps serving after a reader goes away', async () => {
    // A browser tab that closes mid-stream leaves a dead response behind. Writing to it must not
    // take the daemon down, or every other tab stops updating too.
    const ctrl = new AbortController();
    const res = await fetch(`${base}/api/events`, { signal: ctrl.signal });
    await res.body!.getReader().read();
    ctrl.abort();
    await new Promise((r) => setTimeout(r, 150));

    const got = read((t) => t.includes('"taskId"'));
    await new Promise((r) => setTimeout(r, 50));
    await runner.message(taskId, 'after the reader left', 'note');
    expect(await got).toContain(`"taskId":"${taskId}"`);
  });
});
