import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/db.ts';
import { Runner } from '../src/runner.ts';
import { makeViews } from '../src/server.ts';
import type { Executors, LiveSession, SessionOptions } from '../src/executors.ts';

/**
 * The 5 ways the board lied on 24 November 2026, each named after the task it was found on. Every
 * one of them came out of ~/.orstra/orstra.db, not out of an idea about what might go wrong.
 */

const SIMPLE = `
name: Simple
steps:
  work:
    title: In progress
    use: agent
    prompt: Do {{ trigger.title }}
    next: review
  review:
    title: In review
    use: human
    question: Is the work good?
    on:
      approved: end
      changes_requested: work
`;

const done = (did: string) => `## Progress\nDid: ${did}\nDecided: nothing\nLeft: nothing\nAvoid: nothing\n\nOUTCOME: done`;

function setup(reply: (text: string, n: number) => string | null) {
  const dir = mkdtempSync(join(tmpdir(), 'orstra-truth-'));
  const wfPath = join(dir, 'wf.yaml');
  writeFileSync(wfPath, SIMPLE);
  let n = 0;
  const sessions: SessionOptions[] = [];
  const exec: Executors = {
    session(_kind, opts): LiveSession {
      sessions.push(opts);
      let ended = false;
      let close!: (r: { ok: boolean }) => void;
      const closed = new Promise<{ ok: boolean }>((r) => (close = r));
      return {
        send(text) {
          const k = ++n;
          setTimeout(() => {
            if (ended) return;
            opts.onEvent({ kind: 'message', text: 'working' });
            const r = reply(text, k);
            if (r !== null) opts.onTurn({ text: r, interrupted: false, isError: false });
          }, 1);
        },
        interrupt() { setTimeout(() => !ended && opts.onTurn({ text: '', interrupted: true, isError: false }), 1); },
        end() { ended = true; close({ ok: true }); },
        kill() { ended = true; close({ ok: true }); },
        closed,
      };
    },
    async gate() { return { pass: true, output: '' }; },
    async ask() { return ''; },
  };
  const store = new Store(':memory:');
  const runner = new Runner(store, exec, { slots: 2, createWorktree: () => dir, turnGraceMs: 0 });
  const views = makeViews(store, runner);
  return { store, runner, views, wfPath, exec, dir };
}

/** Run the agent, then stop at the decision. */
async function atTheDecision(reply: (text: string, n: number) => string | null) {
  const s = setup(reply);
  const task = s.runner.startTask({ workflowPath: s.wfPath, title: 'include a file in a chat message' });
  await s.runner.idle();
  expect(s.views.taskSummary(s.store.task(task.id)!).state).toBe('decision');
  return { ...s, task };
}

describe('the board says what is true', () => {
  it('t-mwtzpbti2n1a: a chat at a decision does not leave the board at Decide', async () => {
    const { store, runner, views, task } = await atTheDecision((_t, n) => (n === 1 ? done('first pass') : null));

    await runner.message(task.id, 'wait, what did you implement exactly?', 'chat');

    const v = views.taskSummary(store.task(task.id)!);
    expect(v.state).toBe('working');
    expect(v.currentStepTitle).toBe('In progress');
    expect(v.run).toMatchObject({ attempt: 2, kind: 'agent', status: 'running' });
    expect(views.taskDetail(store.task(task.id)!).human).toBe(null);

    runner.interrupt(task.id);
    await runner.idle();
  });

  it('t-mwt5ry: work after the run ended lands in a run row with a progress entry', async () => {
    const { store, runner, task } = await atTheDecision((_t, n) => done(n === 1 ? 'first pass' : 'did what you asked in chat'));

    await runner.message(task.id, 'also update the changelog', 'chat');
    await runner.idle();

    const work2 = store.runsForTask(task.id).find((r) => r.step_id === 'work' && r.attempt === 2)!;
    expect(work2.outcome).toBe('done');
    expect(JSON.parse(work2.progress!).did).toBe('did what you asked in chat');
    expect(work2.routed).toBe('goto:review');
    // And the workflow moved on, so a second review round is open.
    expect(store.runsForTask(task.id).filter((r) => r.kind === 'human')).toHaveLength(2);
  });

  it('t-mwt5ry: an approval cannot land while the agent works', async () => {
    const { store, runner, task } = await atTheDecision((_t, n) => (n === 1 ? done('first pass') : null));
    const review = store.runsForTask(task.id).find((r) => r.kind === 'human')!;

    await runner.message(task.id, 'change the API name', 'chat');

    expect(() => runner.decide(review.id, 'approved')).toThrow();
    expect(store.openRuns().filter((r) => r.task_id === task.id)).toHaveLength(1);
    expect(store.openRun(task.id)!.kind).toBe('agent');

    runner.interrupt(task.id);
    await runner.idle();
  });

  it('t-mwt4ootxs8gp: a run with no live session reads as paused, with the time of its last turn', async () => {
    const { store, runner, exec, dir, wfPath } = setup(() => 'Which timezone?\n\nOUTCOME: needs_you');
    const task = runner.startTask({ workflowPath: wfPath, title: 'what a workspace is' });
    await runner.idle();

    const live = makeViews(store, runner).taskSummary(store.task(task.id)!);
    expect(live.state).toBe('waiting_you');

    // The daemon restarted. No session survives, and no row has to be repaired for the screen to be right.
    const after = makeViews(store, new Runner(store, exec, { slots: 2, createWorktree: () => dir, turnGraceMs: 0 }));
    const v = after.taskSummary(store.task(task.id)!);
    expect(v.state).toBe('paused');
    expect(v.lastTurnAt).toBeGreaterThan(Date.now() - 5000);
  });

  it('a task whose last run routed nowhere reads as stuck, not as running', async () => {
    const { store, runner, views, task } = await atTheDecision(() => done('first pass'));
    const review = store.runsForTask(task.id).find((r) => r.kind === 'human')!;

    // The fault this guards: something closed the only open run and nothing opened another.
    store.updateRun(review.id, { status: 'stopped', ended_at: Date.now() });
    runner.rebuild(task.id);

    const v = views.taskSummary(store.task(task.id)!);
    expect(v.state).toBe('blocked');
    expect(v.stateReason).toBe('lost');
    expect(v.status).toBe('needs_you');
  });
});
