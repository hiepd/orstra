import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/db.ts';
import { Runner } from '../src/runner.ts';
import type { Executors, LiveSession, SessionOptions } from '../src/executors.ts';

const DONE = 'did it\n\n## Progress\nDid: the work\n\nOUTCOME: done';

/**
 * Agent sessions whose turns the test scripts: `turn(n)` gives the n-th turn of any session, as an
 * error text (a fault), a crash (the process exits), a hang (nothing), or a normal reply.
 */
type Turn = { error: string } | { crash: string } | 'hang' | string;
function scripted(turn: (n: number) => Turn) {
  const opened: SessionOptions[] = [];
  const sent: string[] = [];
  let n = 0;
  const exec: Executors = {
    session(_kind, opts): LiveSession {
      opened.push(opts);
      let done!: (r: { ok: boolean; error?: string }) => void;
      const closed = new Promise<{ ok: boolean; error?: string }>((r) => (done = r));
      return {
        send(text) {
          sent.push(text);
          const t = turn(++n);
          setTimeout(() => {
            if (t === 'hang') return;
            if (typeof t === 'string') return opts.onTurn({ text: t, interrupted: false, isError: false });
            if ('error' in t) return opts.onTurn({ text: t.error, interrupted: false, isError: true });
            done({ ok: false, error: t.crash });
          }, 1);
        },
        interrupt() {},
        end() { done({ ok: true }); },
        kill() { done({ ok: true }); },
        closed,
      };
    },
    async gate() { return { pass: true, output: '' }; },
    async ask() { return ''; },
  };
  return { exec, opened, sent };
}

function setup(step: string, turn: (n: number) => Turn) {
  const dir = mkdtempSync(join(tmpdir(), 'orstra-retry-'));
  const wf = join(dir, 'wf.yaml');
  writeFileSync(wf, `name: X\nsteps:\n  work:\n    use: agent\n    prompt: go\n${step}    next: end\n`);
  const store = new Store(':memory:');
  const s = scripted(turn);
  const runner = new Runner(store, s.exec, { slots: 1, createWorktree: () => dir, turnGraceMs: 5 });
  const task = runner.startTask({ workflowPath: wf, title: 'x' });
  return { store, runner, task, ...s };
}

const texts = (store: Store, taskId: string) => store.events(taskId).filter((e) => e.kind === 'system').map((e) => JSON.parse(e.payload).text as string).join('\n');
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('a fault in an agent step', () => {
  it('is retried in the same session, and the arrows never see it', async () => {
    const t = setup('    retry: { delay: 0s }\n', (n) => (n === 1 ? { error: 'API Error: 529 overloaded' } : DONE));
    await wait(80);
    await t.runner.idle();
    const runs = t.store.runsForTask(t.task.id);
    expect(runs.map((r) => [r.outcome, r.routed])).toEqual([['crashed', 'retry'], ['done', 'end']]);
    expect(runs[1].retries).toBe(1);
    expect(t.opened[1]).toMatchObject({ sessionId: runs[0].session_id, resume: true });
    expect(t.sent[1]).toContain('ended with a fault, not with an outcome: API Error: 529 overloaded');
    expect(t.sent[1]).toContain('retry 1 of 2');
    expect(t.store.task(t.task.id)!.status).toBe('done');
    expect(texts(t.store, t.task.id)).toContain('Orstra retries this step in 1 s (retry 1 of 2)');
  });

  it('retries a process that crashed too', async () => {
    const t = setup('    retry: { delay: 0s }\n', (n) => (n === 1 ? { crash: 'claude exited with code 1' } : DONE));
    await wait(80);
    await t.runner.idle();
    expect(t.store.runsForTask(t.task.id).map((r) => r.outcome)).toEqual(['crashed', 'done']);
  });

  it('goes to the arrows as cant_do when the retries run out', async () => {
    const t = setup('    retry: { max: 1, delay: 0s }\n', () => ({ error: 'API Error: 500' }));
    await wait(80);
    await t.runner.idle();
    const runs = t.store.runsForTask(t.task.id);
    expect(runs.map((r) => r.outcome)).toEqual(['crashed', 'cant_do']);
    expect(t.store.task(t.task.id)).toMatchObject({ status: 'needs_you', inbox_reason: 'cant_do' });
  });

  it('is not retried when the step says retry: false', async () => {
    const t = setup('    retry: false\n', () => ({ error: 'API Error: 500' }));
    await wait(30);
    await t.runner.idle();
    expect(t.store.runsForTask(t.task.id).map((r) => r.outcome)).toEqual(['cant_do']);
  });

  it('waits out the delay before the retry starts', async () => {
    const t = setup('    retry: { delay: 0.3s }\n', (n) => (n === 1 ? { error: 'API Error: 529' } : DONE));
    await wait(60);
    const retry = t.store.runsForTask(t.task.id)[1];
    expect(retry.status).toBe('queued');
    expect(retry.not_before! - Date.now()).toBeGreaterThan(100);
    expect(t.opened).toHaveLength(1);
    await wait(400);
    await t.runner.idle();
    expect(t.store.run(retry.id)!.outcome).toBe('done');
  });

  it('waits until a usage limit lifts, not for the backoff', async () => {
    const reset = Math.floor(Date.now() / 1000) + 3600;
    const t = setup('', (n) => (n === 1 ? { error: `Claude AI usage limit reached|${reset}` } : DONE));
    await wait(40);
    const retry = t.store.runsForTask(t.task.id)[1];
    expect(retry).toMatchObject({ status: 'queued', not_before: reset * 1000 });
    expect(texts(t.store, t.task.id)).toContain('when the usage limit lifts');
  });

  it('does not retry a timeout unless the step says onTimeout', async () => {
    const plain = setup('    timeout: 0.001\n', () => 'hang');
    await wait(150);
    expect(plain.store.runsForTask(plain.task.id).map((r) => r.outcome)).toEqual(['timeout']);

    const retried = setup('    timeout: 0.001\n    retry: { delay: 0s, onTimeout: true, max: 1 }\n', (n) => (n === 1 ? 'hang' : DONE));
    await wait(200);
    await retried.runner.idle();
    expect(retried.store.runsForTask(retried.task.id).map((r) => r.outcome)).toEqual(['timeout', 'done']);
  });
});
