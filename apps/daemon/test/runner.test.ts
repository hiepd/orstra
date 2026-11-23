import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/db.ts';
import { Runner } from '../src/runner.ts';
import type { Executors, LiveSession, SessionOptions } from '../src/executors.ts';

interface Sent { sessionId: string; resume: boolean; text: string }

/** A fake streaming agent: every message it receives produces one turn, scripted by `reply`. */
/** `reply` returning null means the agent is still working on that turn (nothing comes back until interrupted). */
function fakeExecutors(reply: (text: string, n: number, opts: SessionOptions) => string | null, gate: (n: number) => boolean) {
  const sent: Sent[] = [];
  const sessions: SessionOptions[] = [];
  let n = 0;
  let gates = 0;
  const exec: Executors = {
    session(_kind, opts): LiveSession {
      sessions.push(opts);
      let ended = false;
      let done!: (r: { ok: boolean }) => void;
      const closed = new Promise<{ ok: boolean }>((r) => (done = r));
      return {
        send(text) {
          sent.push({ sessionId: opts.sessionId, resume: opts.resume, text });
          const k = ++n;
          setTimeout(() => {
            if (ended) return;
            opts.onEvent({ kind: 'message', text: 'working' });
            const r = reply(text, k, opts);
            if (r !== null) opts.onTurn({ text: r, interrupted: false, isError: false });
          }, 1);
        },
        interrupt() {
          setTimeout(() => !ended && opts.onTurn({ text: '', interrupted: true, isError: false }), 1);
        },
        end() { ended = true; done({ ok: true }); },
        kill() { ended = true; done({ ok: true }); },
        closed,
      };
    },
    async gate() {
      const pass = gate(++gates);
      return { pass, output: pass ? 'all green' : 'FAIL expected "No posts yet"' };
    },
    async ask() {
      return 'because';
    },
  };
  return { exec, sent, sessions };
}

function setup(yaml: string, reply: (text: string, n: number, opts: SessionOptions) => string | null, gate: (n: number) => boolean = () => true) {
  const dir = mkdtempSync(join(tmpdir(), 'orstra-test-'));
  const wfPath = join(dir, 'wf.yaml');
  writeFileSync(wfPath, yaml);
  const fake = fakeExecutors(reply, gate);
  const store = new Store(':memory:');
  const runner = new Runner(store, fake.exec, { slots: 2, createWorktree: () => dir, turnGraceMs: 0 });
  const prompts = () => fake.sent.filter((s, i) => fake.sent.findIndex((x) => x.sessionId === s.sessionId) === i && !s.resume).map((s) => s.text);
  return { store, runner, wfPath, prompts, fake, dir };
}

const LOOP = `
name: Fix
steps:
  impl:
    use: agent
    prompt: Fix {{ trigger.title }}
    next: verify
  verify:
    use: gate
    run: [npm test]
    on:
      pass: end
      fail: { goto: impl, max: 2 }
`;

const done = (did: string) => `## Progress\nDid: ${did}\nDecided: nothing\nLeft: nothing\nAvoid: nothing\n\nOUTCOME: done`;

describe('Runner', () => {
  it('retries through a failing gate with a fresh session that sees earlier progress', async () => {
    const { store, runner, wfPath, prompts } = setup(LOOP, (_t, n) => done(`attempt ${n}`), (n) => n >= 2);
    const task = runner.startTask({ workflowPath: wfPath, title: 'empty state' });
    await runner.idle();

    expect(store.task(task.id)!.status).toBe('done');
    const runs = store.runsForTask(task.id);
    expect(runs.map((r) => `${r.step_id}#${r.attempt}:${r.outcome}`)).toEqual(['impl#1:done', 'verify#1:fail', 'impl#2:done', 'verify#2:pass']);
    expect(new Set(runs.filter((r) => r.session_id).map((r) => r.session_id)).size).toBe(2);
    expect(prompts()[0]).toContain('Fix empty state');
    expect(prompts()[1]).toContain('Did: attempt 1');
    expect(prompts()[1]).toContain('FAIL expected "No posts yet"');
    expect(prompts()[1]).toContain('attempt 2 of this step');
  });

  it('sends the task to the inbox when the loop cap is reached', async () => {
    const { store, runner, wfPath } = setup(LOOP, () => done('tried'), () => false);
    const task = runner.startTask({ workflowPath: wfPath, title: 'never green' });
    await runner.idle();
    const t = store.task(task.id)!;
    expect(t.status).toBe('needs_you');
    expect(t.inbox_reason).toBe('loop_exhausted');
    expect(store.runsForTask(task.id).filter((r) => r.step_id === 'impl')).toHaveLength(3);
  });

  it('waits for a human decision and passes the comment to the step that runs next', async () => {
    const yaml = `
name: Spec first
steps:
  spec:
    use: agent
    prompt: Write a spec
    next: approve
  approve:
    use: human
    question: Is this the right thing to build?
    on:
      approved: end
      changes_requested: { goto: spec, max: 3 }
      rejected: end
`;
    const { store, runner, wfPath, prompts } = setup(yaml, (_t, n) => done(`spec v${n}`));
    const task = runner.startTask({ workflowPath: wfPath, title: 'timezones' });
    await runner.idle();
    expect(store.task(task.id)!.inbox_reason).toBe('decision');
    const waiting = store.runsForTask(task.id).find((r) => r.status === 'waiting')!;

    runner.decide(waiting.id, 'changes_requested', 'Default to the studio timezone');
    await runner.idle();
    expect(prompts()[1]).toContain('Default to the studio timezone');
    expect(prompts()[1]).toContain('Did: spec v1');

    const again = store.runsForTask(task.id).find((r) => r.status === 'waiting')!;
    runner.decide(again.id, 'approved');
    await runner.idle();
    expect(store.task(task.id)!.status).toBe('done');
  });

  it('keeps the session open when the agent asks a question, and your reply continues it', async () => {
    const { store, runner, wfPath, fake } = setup(LOOP, (text) =>
      text.includes('studio') ? done('used the studio timezone') : 'Which timezone should I default to?\n\nOUTCOME: needs_you',
    );
    const task = runner.startTask({ workflowPath: wfPath, title: 'tz' });
    await runner.idle();
    expect(store.task(task.id)!.inbox_reason).toBe('question');
    const impl = store.runsForTask(task.id)[0];
    expect(impl.status).toBe('waiting');
    expect(runner.isLive(impl.id)).toBe(true);

    await runner.message(task.id, 'Use the studio timezone', 'chat');
    await runner.idle();
    expect(fake.sent.filter((s) => s.sessionId === impl.session_id && !s.resume)).toHaveLength(2);
    expect(fake.sessions).toHaveLength(1);
    expect(store.task(task.id)!.status).toBe('done');
    expect(store.events(task.id).some((e) => e.kind === 'you' && JSON.parse(e.payload).mode === 'chat')).toBe(true);
  });

  it('waits for your reply when it answers you without finishing the step', async () => {
    const { store, runner, wfPath } = setup(LOOP, (text, n) => (n === 1 ? 'Which timezone?\n\nOUTCOME: needs_you' : text.includes('why') ? 'Because the ticket says so.' : done('ok')));
    const task = runner.startTask({ workflowPath: wfPath, title: 'tz' });
    await runner.idle();
    await runner.message(task.id, 'why do you ask?', 'chat');
    await runner.idle();
    expect(store.task(task.id)!.inbox_reason).toBe('reply');
    await runner.message(task.id, 'Studio timezone. Go ahead.', 'chat');
    await runner.idle();
    expect(store.task(task.id)!.status).toBe('done');
  });

  it('resumes the same session when you message it after a restart', async () => {
    const { store, runner, wfPath, fake, dir } = setup(LOOP, (text) => (text.includes('carry on') ? done('finished') : 'Need input\n\nOUTCOME: needs_you'));
    const task = runner.startTask({ workflowPath: wfPath, title: 'restart' });
    await runner.idle();
    const impl = store.runsForTask(task.id)[0];

    const runner2 = new Runner(store, fake.exec, { slots: 2, createWorktree: () => dir, turnGraceMs: 0 });
    await runner2.message(task.id, 'carry on', 'chat');
    await runner2.idle();
    const resumed = fake.sessions[fake.sessions.length - 1];
    expect(resumed.resume).toBe(true);
    expect(resumed.sessionId).toBe(impl.session_id);
    expect(store.task(task.id)!.status).toBe('done');
  });

  it('interrupt pauses the run until you say what to do next', async () => {
    const { store, runner, wfPath } = setup(LOOP, (text) => (text.includes('instead') ? done('did it the other way') : null));
    const task = runner.startTask({ workflowPath: wfPath, title: 'x' });
    await new Promise((r) => setTimeout(r, 5));
    runner.interrupt(task.id);
    await runner.idle();
    expect(store.task(task.id)!.inbox_reason).toBe('paused');
    expect(store.runsForTask(task.id)[0].status).toBe('waiting');

    await runner.message(task.id, 'Do it this way instead', 'chat');
    await runner.idle();
    expect(store.task(task.id)!.status).toBe('done');
  });

  it('hands notes to the next run of that step', async () => {
    const { runner, wfPath, prompts, store } = setup(LOOP, () => 'stuck\n\nOUTCOME: cant_do');
    const task = runner.startTask({ workflowPath: wfPath, title: 'x' });
    await runner.idle();
    await runner.message(task.id, 'Use the shared EmptyState from ui/', 'note', { stepId: 'impl' });
    runner.retry(task.id);
    await runner.idle();
    expect(prompts()[1]).toContain('Use the shared EmptyState from ui/');
    expect(store.events(task.id).some((e) => e.kind === 'you')).toBe(true);
  });
});
