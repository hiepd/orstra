import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/db.ts';
import { NUDGE, Runner } from '../src/runner.ts';
import { makeViews } from '../src/server.ts';
import { rebuildAll } from '../src/project.ts';
import type { Executors, LiveSession, SessionOptions, TurnUsage } from '../src/executors.ts';

interface Sent { sessionId: string; resume: boolean; text: string }

/** A fake streaming agent: every message it receives produces one turn, scripted by `reply`. */
/** `reply` returning null means the agent is still working on that turn (nothing comes back until interrupted). */
type Reply = string | null | { text: string; usage: TurnUsage };
function fakeExecutors(reply: (text: string, n: number, opts: SessionOptions) => Reply, gate: (n: number) => boolean) {
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
            if (r !== null) opts.onTurn(typeof r === 'string' ? { text: r, interrupted: false, isError: false } : { text: r.text, usage: r.usage, interrupted: false, isError: false });
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

function setup(yaml: string, reply: (text: string, n: number, opts: SessionOptions) => Reply, gate: (n: number) => boolean = () => true, worktree?: string, slots = 2) {
  const dir = mkdtempSync(join(tmpdir(), 'orstra-test-'));
  const wfPath = join(dir, 'wf.yaml');
  writeFileSync(wfPath, yaml);
  const fake = fakeExecutors(reply, gate);
  const store = new Store(':memory:');
  const artifactsRoot = mkdtempSync(join(tmpdir(), 'orstra-test-art-'));
  const runner = new Runner(store, fake.exec, { slots, createWorktree: () => worktree ?? dir, turnGraceMs: 0, artifactsRoot });
  const prompts = () => fake.sent.filter((s, i) => fake.sent.findIndex((x) => x.sessionId === s.sessionId) === i && !s.resume).map((s) => s.text);
  return { store, runner, wfPath, prompts, fake, dir, artifactsRoot };
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

/** The Simple workflow's tail: you close the task, and the merge step runs. */
const CLOSE = `
name: Close
steps:
  work:
    use: agent
    prompt: Do {{ trigger.title }}
    next: review
  review:
    use: human
    question: Close it?
    choices: [close, reopen]
    on:
      close: merge
      reopen: work
  merge:
    use: action
    action: git.merge
    next: end
`;

/** An agent step, then your review. No merge action, so the tests need no repository. */
const REVIEW = `
name: Review
steps:
  work:
    use: agent
    prompt: Do {{ trigger.title }}
    next: review
  review:
    use: human
    question: Close it?
    choices: [close, reopen]
    on:
      close: end
      reopen: work
`;

async function waitFor(ok: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const done = (did: string) => `## Progress\nDid: ${did}\nDecided: nothing\nLeft: nothing\nAvoid: nothing\n\nOUTCOME: done`;

const sh = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });

/** A repository with one commit on main, plus a task worktree on branch orstra/t1. */
function repoWithTask() {
  const repo = mkdtempSync(join(tmpdir(), 'orstra-test-repo-'));
  sh(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'app.ts'), 'export const a = 1;\n');
  sh(repo, 'add', '.');
  sh(repo, 'commit', '-q', '-m', 'base');
  const wt = join(mkdtempSync(join(tmpdir(), 'orstra-test-wt-')), 't1');
  sh(repo, 'worktree', 'add', '-q', wt, '-b', 'orstra/t1');
  return { repo, wt };
}

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

  it('gives the agent the path of a file you attached, and keeps your text on the message', async () => {
    const seen: string[] = [];
    const { store, runner, wfPath } = setup(LOOP, (text, n) => {
      seen.push(text);
      return n === 1 ? 'What should I look at?\n\nOUTCOME: needs_you' : done('read the screenshot');
    });
    const task = runner.startTask({ workflowPath: wfPath, title: 'shot' });
    await runner.idle();

    const file = { name: 'image.png', path: '.orstra/attachments/ab12/image.png', bytes: 188_416, mime: 'image/png' };
    await runner.message(task.id, 'fix this', 'chat', { files: [file] });
    await runner.idle();

    expect(seen[1]).toContain('fix this');
    expect(seen[1]).toContain('.orstra/attachments/ab12/image.png');
    const said = store.events(task.id).map((e) => JSON.parse(e.payload)).find((p) => p.mode === 'chat');
    expect(said.text).toBe('fix this');
    expect(said.files).toEqual([file]);
  });

  it('sends your message unchanged when you attached nothing', async () => {
    const seen: string[] = [];
    const { runner, wfPath, store } = setup(LOOP, (text, n) => {
      seen.push(text);
      return n === 1 ? 'Which one?\n\nOUTCOME: needs_you' : done('ok');
    });
    const task = runner.startTask({ workflowPath: wfPath, title: 'plain' });
    await runner.idle();
    await runner.message(task.id, 'the second one', 'chat');
    await runner.idle();
    expect(seen[1]).toBe('the second one');
    const said = store.events(task.id).map((e) => JSON.parse(e.payload)).find((p) => p.mode === 'chat');
    expect(said.files).toBeUndefined();
  });

  it('hands the paths to the next run when the file goes on a step as a note', async () => {
    const { runner, wfPath, prompts } = setup(LOOP, () => 'stuck\n\nOUTCOME: cant_do');
    const task = runner.startTask({ workflowPath: wfPath, title: 'early' });
    await runner.idle();
    await runner.message(task.id, 'see the log', 'note', {
      stepId: 'impl',
      files: [{ name: 'run.log', path: '.orstra/attachments/cd34/run.log', bytes: 2048, mime: 'text/plain' }],
    });
    runner.retry(task.id);
    await runner.idle();
    expect(prompts()[1]).toContain('see the log');
    expect(prompts()[1]).toContain('.orstra/attachments/cd34/run.log');
  });

  it('merges the task branch on close, and sends a conflict to the inbox', async () => {
    const repoWork = (wt: string) => {
      writeFileSync(join(wt, 'app.ts'), 'export const a = 2;\n');
      sh(wt, 'commit', '-q', '-am', 'change a');
    };

    // Close with a clean main checkout: the branch is merged and the task finishes.
    const first = repoWithTask();
    const a = setup(CLOSE, () => (repoWork(first.wt), done('changed a')), () => true, first.wt);
    const taskA = a.runner.startTask({ workflowPath: a.wfPath, title: 'merge me' });
    await a.runner.idle();
    a.runner.decide(a.store.runsForTask(taskA.id).find((r) => r.status === 'waiting')!.id, 'close');
    await a.runner.idle();
    expect(a.store.task(taskA.id)!.status).toBe('done');
    const mergeRun = a.store.runsForTask(taskA.id).find((r) => r.step_id === 'merge')!;
    expect(mergeRun.outcome).toBe('ok');
    expect(mergeRun.output).toContain('Merged orstra/t1 into main');
    expect(sh(first.repo, 'show', 'HEAD:app.ts').toString()).toBe('export const a = 2;\n');

    // Close when main moved the same line: nothing is merged and the task comes to you.
    const second = repoWithTask();
    const b = setup(CLOSE, () => (repoWork(second.wt), done('changed a')), () => true, second.wt);
    const taskB = b.runner.startTask({ workflowPath: b.wfPath, title: 'conflict' });
    await b.runner.idle();
    writeFileSync(join(second.repo, 'app.ts'), 'export const a = 99;\n');
    sh(second.repo, 'commit', '-q', '-am', 'main side');
    const head = sh(second.repo, 'rev-parse', 'HEAD').toString();
    b.runner.decide(b.store.runsForTask(taskB.id).find((r) => r.status === 'waiting')!.id, 'close');
    await b.runner.idle();
    const t = b.store.task(taskB.id)!;
    expect(t.status).toBe('needs_you');
    expect(t.inbox_reason).toBe('conflict');
    expect(sh(second.repo, 'rev-parse', 'HEAD').toString()).toBe(head);
    expect(sh(second.repo, 'status', '--porcelain').toString()).toBe('');
  });

  it('sends the task back to the agent when you chat during a human step', async () => {
    const { store, runner, wfPath, fake } = setup(REVIEW, (_t, n) => done(n === 1 ? 'first pass' : 'added the changelog'));
    const task = runner.startTask({ workflowPath: wfPath, title: 'changelog' });
    await runner.idle();
    const work1 = store.runsForTask(task.id)[0];
    const review = store.runsForTask(task.id).find((r) => r.kind === 'human')!;
    expect(review.status).toBe('waiting');

    await runner.message(task.id, 'also update the changelog', 'chat');

    // The task reads as working again, at the agent's step, with nothing waiting on you.
    const mid = store.task(task.id)!;
    expect(mid.status).toBe('running');
    expect(mid.current_step).toBe('work');
    expect(mid.inbox_reason).toBe(null);
    expect(store.runsForTask(task.id).filter((r) => r.status === 'waiting')).toHaveLength(0);
    expect(store.run(review.id)!.status).toBe('stopped');
    expect(store.run(review.id)!.outcome).toBe('reopened');

    // A run row of its own, on the same session, with the finish instructions.
    const work2 = store.runsForTask(task.id).find((r) => r.step_id === 'work' && r.attempt === 2)!;
    expect(work2.status).toBe('running');
    expect(work2.kind).toBe('agent');
    expect(work2.session_id).toBe(work1.session_id);
    // Your words sit in the new run's transcript, with the work they asked for.
    const chat = store.events(task.id).find((e) => e.kind === 'you' && JSON.parse(e.payload).mode === 'chat')!;
    expect(chat.run_id).toBe(work2.id);

    const resumed = fake.sent[fake.sent.length - 1];
    expect(resumed.sessionId).toBe(work1.session_id);
    expect(resumed.resume).toBe(true);
    expect(resumed.text).toContain('also update the changelog');
    expect(resumed.text).toContain('OUTCOME: done | needs_you | cant_do');

    await runner.idle();
    // The new work kept its own progress entry, and its outcome moved the workflow on.
    expect(JSON.parse(store.run(work2.id)!.progress!).did).toBe('added the changelog');
    expect(store.run(work2.id)!.outcome).toBe('done');
    const rounds = store.runsForTask(task.id).filter((r) => r.kind === 'human');
    expect(rounds).toHaveLength(2);
    expect(rounds[1].status).toBe('waiting');
  });

  it('shows the task as running and drops the decision once the agent is back on it', async () => {
    const { store, runner, wfPath } = setup(REVIEW, (_t, n) => (n === 1 ? done('first pass') : null));
    const task = runner.startTask({ workflowPath: wfPath, title: 'board' });
    await runner.idle();
    const views = makeViews(store, runner);
    expect(views.taskDetail(store.task(task.id)!).human).not.toBe(null);

    await runner.message(task.id, 'rename the flag', 'chat');

    const detail = views.taskDetail(store.task(task.id)!);
    expect(detail.human).toBe(null);
    expect(detail.status).toBe('running');
    expect(detail.currentStep).toBe('work');
    expect(detail.run).toEqual({ status: 'running', attempt: 2, kind: 'agent' });

    runner.interrupt(task.id);
    await runner.idle();
  });

  it('cannot hold a waiting decision while an agent run works, so approval cannot merge a diff in flight', async () => {
    const { store, runner, wfPath } = setup(REVIEW, (_t, n) => (n === 1 ? done('first pass') : null));
    const task = runner.startTask({ workflowPath: wfPath, title: 'guard' });
    await runner.idle();
    const review = store.runsForTask(task.id).find((r) => r.kind === 'human')!;

    // The state a stale page would need is one the database refuses to hold.
    expect(() => store.insertRun({ ...store.runsForTask(task.id)[0], id: 'r-fake', status: 'running' })).toThrow();

    // Your chat closes that decision and sends the step back, so there is nothing left to approve.
    await runner.message(task.id, 'change the API name', 'chat');
    expect(() => runner.decide(review.id, 'close')).toThrow(/no longer waiting/);
    expect(store.openRuns().filter((r) => r.task_id === task.id)).toHaveLength(1);

    runner.interrupt(task.id);
    await runner.idle();
  });

  it('keeps one run when you chat to an agent that is still working', async () => {
    const { store, runner, wfPath, fake } = setup(LOOP, (text) => (text.includes('instead') ? done('did it the other way') : null));
    const task = runner.startTask({ workflowPath: wfPath, title: 'mid-turn' });
    await new Promise((r) => setTimeout(r, 5));
    expect(store.runsForTask(task.id)[0].status).toBe('running');

    await runner.message(task.id, 'do it this way instead', 'chat');

    expect(store.runsForTask(task.id).filter((r) => r.step_id === 'impl')).toHaveLength(1);
    expect(fake.sessions).toHaveLength(1);
    await runner.idle();
    expect(store.task(task.id)!.status).toBe('done');
  });

  it('does not move a stopped task when you chat to its agent', async () => {
    const { store, runner, wfPath, fake } = setup(LOOP, (_t, n) => (n === 1 ? 'Which one?\n\nOUTCOME: needs_you' : done('ok')));
    const task = runner.startTask({ workflowPath: wfPath, title: 'stopped' });
    await runner.idle();
    runner.stop(task.id);
    await new Promise((r) => setTimeout(r, 5));
    const before = store.runsForTask(task.id).length;

    await runner.message(task.id, 'carry on', 'chat');
    await runner.idle();

    expect(store.task(task.id)!.status).toBe('stopped');
    expect(store.runsForTask(task.id)).toHaveLength(before);
    expect(fake.sent[fake.sent.length - 1].text).toContain('carry on');
  });

  it('does not reopen a finished task when you chat to its agent', async () => {
    const { store, runner, wfPath, fake } = setup(REVIEW, () => done('shipped'));
    const task = runner.startTask({ workflowPath: wfPath, title: 'finished' });
    await runner.idle();
    runner.decide(store.runsForTask(task.id).find((r) => r.status === 'waiting')!.id, 'close');
    await runner.idle();
    expect(store.task(task.id)!.status).toBe('done');
    const before = store.runsForTask(task.id).length;

    await runner.message(task.id, 'one more thing', 'chat');
    await runner.idle();

    const t = store.task(task.id)!;
    expect(t.status).toBe('done');
    expect(t.current_step).toBe(null);
    expect(store.runsForTask(task.id)).toHaveLength(before);
    expect(fake.sent[fake.sent.length - 1].text).toContain('one more thing');
    expect(store.events(task.id).some((e) => e.kind === 'system' && String(JSON.parse(e.payload).text).includes('finished'))).toBe(true);
  });

  it('records what the router decided on the run that ended', async () => {
    const { store, runner, wfPath } = setup(REVIEW, () => done('first pass'));
    const task = runner.startTask({ workflowPath: wfPath, title: 'routed' });
    await runner.idle();
    expect(store.runsForTask(task.id)[0].routed).toBe('goto:review');

    const review = store.runsForTask(task.id).find((r) => r.status === 'waiting')!;
    runner.decide(review.id, 'close');
    await runner.idle();
    expect(store.run(review.id)!.routed).toBe('end');
  });

  it('records a block on the run whose outcome had no arrow', async () => {
    const { store, runner, wfPath } = setup(LOOP, () => done('tried'), () => false);
    const task = runner.startTask({ workflowPath: wfPath, title: 'no arrow' });
    await runner.idle();
    const last = store.runsForTask(task.id).at(-1)!;
    expect(last.step_id).toBe('verify');
    expect(last.routed).toBe('block:loop_exhausted');
  });

  it('writes the time a turn ended on the run', async () => {
    const { store, runner, wfPath } = setup(LOOP, () => 'Which timezone?\n\nOUTCOME: needs_you');
    const task = runner.startTask({ workflowPath: wfPath, title: 'turn' });
    await runner.idle();
    const impl = store.runsForTask(task.id)[0];
    expect(impl.last_turn_at).toBeGreaterThan(Date.now() - 2000);
    expect(impl.last_turn_at).toBeLessThanOrEqual(Date.now());
  });

  it('writes the wait reason on the run, not only on the task', async () => {
    const { store, runner, wfPath } = setup(LOOP, (text, n) => (n === 1 ? 'Which one?\n\nOUTCOME: needs_you' : text.includes('why') ? 'Because the ticket says so.' : done('ok')));
    const task = runner.startTask({ workflowPath: wfPath, title: 'reasons' });
    await runner.idle();
    const impl = store.runsForTask(task.id)[0];
    expect(store.run(impl.id)!.wait_reason).toBe('question');

    await runner.message(task.id, 'why do you ask?', 'chat');
    await runner.idle();
    expect(store.run(impl.id)!.wait_reason).toBe('reply');
  });

  // Review Focus: retry used to leave a queued run open, which the 1 open run index now refuses.
  it('re-runs a step that was queued without breaking the 1 open run rule', async () => {
    const { store, runner, wfPath } = setup(LOOP, () => done('ok'), () => true, undefined, 0);
    const task = runner.startTask({ workflowPath: wfPath, title: 'queued' });
    expect(store.openRun(task.id)!.status).toBe('queued');

    expect(() => runner.retry(task.id)).not.toThrow();
    expect(store.runsForTask(task.id).filter((r) => r.status === 'queued')).toHaveLength(1);
    expect(store.openRuns().filter((r) => r.task_id === task.id)).toHaveLength(1);
  });

  // Review Focus 4: the product tells you to re-run a stopped task, so a re-run must lift the stop.
  it('clears the stop when you re-run a stopped task', async () => {
    const { store, runner, wfPath } = setup(LOOP, (text, n) => (n === 1 ? 'Which one?\n\nOUTCOME: needs_you' : done('ok')));
    const task = runner.startTask({ workflowPath: wfPath, title: 'revive' });
    await runner.idle();

    runner.stop(task.id);
    expect(store.task(task.id)!.stopped_at).toBeGreaterThan(0);

    runner.retry(task.id);
    expect(store.task(task.id)!.stopped_at).toBe(null);
    await runner.idle();
    expect(store.task(task.id)!.status).toBe('done');

    runner.stop(task.id);
    expect(store.task(task.id)!.stopped_at).toBeGreaterThan(0);
  });

  it('keeps the task row true at every step of a task', async () => {
    const seen: string[] = [];
    const { store, runner, wfPath } = setup(REVIEW, (text, n) => (n === 1 ? 'Which timezone?\n\nOUTCOME: needs_you' : done('used the studio timezone')));
    const task = runner.startTask({ workflowPath: wfPath, title: 'true at every step' });
    const row = () => {
      const t = store.task(task.id)!;
      return `${t.status}/${t.inbox_reason ?? '-'}/${t.current_step ?? '-'}`;
    };
    seen.push(row());
    await runner.idle();
    seen.push(row());
    await runner.message(task.id, 'the studio one', 'chat');
    seen.push(row());
    await runner.idle();
    seen.push(row());
    runner.decide(store.runsForTask(task.id).find((r) => r.status === 'waiting')!.id, 'close');
    await runner.idle();
    seen.push(row());
    runner.stop(task.id);
    seen.push(row());

    expect(seen).toEqual([
      'running/-/work',
      'needs_you/question/work',
      'running/-/work',
      'needs_you/decision/review',
      'done/-/-',
      // A stopped task keeps the step it stopped at, which is what a re-run starts from.
      'stopped/-/review',
    ]);
  });

  it('reads an agent run as paused after a restart, and frees its slot', async () => {
    const { store, runner, wfPath, fake, dir } = setup(LOOP, () => 'Need input\n\nOUTCOME: needs_you');
    const task = runner.startTask({ workflowPath: wfPath, title: 'restart' });
    await runner.idle();
    const impl = store.runsForTask(task.id)[0];
    store.updateRun(impl.id, { status: 'running', wait_reason: null }); // as a daemon that died mid-turn would leave it

    const runner2 = new Runner(store, fake.exec, { slots: 2, createWorktree: () => dir, turnGraceMs: 0 });
    runner2.recover();

    expect(store.run(impl.id)).toMatchObject({ status: 'waiting', wait_reason: 'paused' });
    expect(store.task(task.id)).toMatchObject({ status: 'needs_you', inbox_reason: 'paused', current_step: 'impl' });
    expect(store.runsByStatus('running')).toHaveLength(0);
    await runner2.idle();
  });

  it('still fails a gate run that died with the process', async () => {
    const { store, runner, wfPath, fake, dir } = setup(LOOP, () => done('ok'));
    const task = runner.startTask({ workflowPath: wfPath, title: 'dead gate' });
    await runner.idle();
    const verify = store.runsForTask(task.id).find((r) => r.kind === 'gate')!;
    store.updateRun(verify.id, { status: 'running', outcome: null, ended_at: null, routed: null });

    new Runner(store, fake.exec, { slots: 2, createWorktree: () => dir, turnGraceMs: 0 }).recover();

    expect(store.run(verify.id)).toMatchObject({ status: 'failed', outcome: 'interrupted', routed: 'block:interrupted' });
    expect(store.task(task.id)).toMatchObject({ status: 'needs_you', inbox_reason: 'interrupted' });
  });

  it('rebuilds the same state it had', async () => {
    const { store, runner, wfPath } = setup(REVIEW, () => done('first pass'));
    const task = runner.startTask({ workflowPath: wfPath, title: 'rebuild' });
    await runner.idle();
    const before = store.task(task.id)!;

    store.updateTask(task.id, { status: 'running', inbox_reason: null, current_step: 'work' });
    expect(rebuildAll(store, () => false)).toEqual([{ taskId: task.id, from: 'running', to: 'needs_you' }]);
    expect(store.task(task.id)).toMatchObject({ status: before.status, inbox_reason: before.inbox_reason, current_step: before.current_step });
  });

  it('answers with the live state, computed at the read', async () => {
    const { store, runner, wfPath, fake, dir } = setup(LOOP, () => 'Need input\n\nOUTCOME: needs_you');
    const task = runner.startTask({ workflowPath: wfPath, title: 'live read' });
    await runner.idle();

    const views = makeViews(store, runner);
    expect(views.taskSummary(store.task(task.id)!)).toMatchObject({ state: 'waiting_you', stateReason: 'question' });
    expect(views.taskSummary(store.task(task.id)!).lastTurnAt).toBeGreaterThan(Date.now() - 2000);

    // A second Runner has no live sessions. The same rows now read as paused, and no row is written.
    const before = store.task(task.id)!.updated_at;
    const views2 = makeViews(store, new Runner(store, fake.exec, { slots: 2, createWorktree: () => dir, turnGraceMs: 0 }));
    expect(views2.taskSummary(store.task(task.id)!).state).toBe('paused');
    expect(store.task(task.id)!.updated_at).toBe(before);
    expect(store.task(task.id)!.inbox_reason).toBe('question');
  });

  it('re-runs the step it was stopped at, not the one before it', async () => {
    const { store, runner, wfPath } = setup(REVIEW, () => done('first pass'));
    const task = runner.startTask({ workflowPath: wfPath, title: 'stop at the decision' });
    await runner.idle();
    expect(store.task(task.id)!.current_step).toBe('review');

    runner.stop(task.id);
    expect(store.task(task.id)!.current_step).toBe('review');

    runner.retry(task.id);
    expect(store.openRun(task.id)).toMatchObject({ step_id: 'review', kind: 'human' });
    await runner.idle();
  });

  it('ignores an outcome that arrives after its run was closed', async () => {
    const { store, runner, wfPath } = setup(LOOP, () => done('ok'));
    const task = runner.startTask({ workflowPath: wfPath, title: 'late outcome' });
    await runner.idle();
    const impl = store.runsForTask(task.id)[0];
    const runs = store.runsForTask(task.id).length;

    // A step that was closed by a retry or a stop can still have an outcome on the way.
    store.updateRun(impl.id, { status: 'stopped', outcome: null, routed: null });
    expect(() => (runner as unknown as { finish: (t: string, r: string, o: string) => void }).finish(task.id, impl.id, 'cant_do')).not.toThrow();
    expect(store.run(impl.id)!.status).toBe('stopped');
    expect(store.runsForTask(task.id)).toHaveLength(runs);
  });

  it('has no writer of the task state but the projector', () => {
    const dir = join(import.meta.dirname, '../src');
    const writers = readdirSync(dir)
      .filter((f) => f.endsWith('.ts'))
      .filter((f) => /updateTask\([^)]*(status|current_step|inbox_reason)/s.test(readFileSync(join(dir, f), 'utf8')));
    expect(writers).toEqual(['project.ts']);
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

  it('asks once for a missing OUTCOME line, and reads the answer', async () => {
    const { store, runner, wfPath, fake } = setup(LOOP, (text, n) => (n === 1 ? 'I changed the file.' : done('changed the file')));
    const task = runner.startTask({ workflowPath: wfPath, title: 'x' });
    await runner.idle();
    expect(fake.sent[1].text).toBe(NUDGE);
    expect(store.task(task.id)!.status).toBe('done');
  });

  it('never reads a reply without an OUTCOME line as done', async () => {
    const { store, runner, wfPath } = setup(LOOP, () => 'I changed the fi');
    const task = runner.startTask({ workflowPath: wfPath, title: 'x' });
    await waitFor(() => store.task(task.id)!.status === 'needs_you');
    expect(store.task(task.id)!.inbox_reason).toBe('no_outcome');
    expect(store.runsForTask(task.id).filter((r) => r.step_id === 'verify')).toHaveLength(0);
  });

  it('stops an agent step that works longer than its timeout and sends the task to the inbox', async () => {
    const { store, runner, wfPath } = setup(LOOP.replace('next: verify', 'next: verify\n    timeout: 0.0005'), () => null);
    const task = runner.startTask({ workflowPath: wfPath, title: 'x' });
    await waitFor(() => store.task(task.id)!.status === 'needs_you');
    const t = store.task(task.id)!;
    expect(t.inbox_reason).toBe('timeout');
    expect(store.runsForTask(task.id)[0].outcome).toBe('timeout');
  });

  it('stops a gate that hangs, using the default gate timeout', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orstra-test-'));
    const wfPath = join(dir, 'wf.yaml');
    writeFileSync(wfPath, 'name: G\nsteps:\n  check:\n    use: gate\n    run: [sleep 100]\n    on: { pass: end }\n');
    const exec = {
      gate: ({ signal }: { signal: AbortSignal }) => new Promise((r) => signal.addEventListener('abort', () => r({ pass: false, output: 'killed' }))),
    } as unknown as Executors;
    const store = new Store(':memory:');
    const runner = new Runner(store, exec, { slots: 1, createWorktree: () => dir, defaultTimeoutMs: { gate: 20 } });
    const task = runner.startTask({ workflowPath: wfPath, title: 'x' });
    await waitFor(() => store.task(task.id)!.status === 'needs_you');
    expect(store.task(task.id)!.inbox_reason).toBe('timeout');
  });

  it('keeps a running task on the workflow it started with, until you move it to the new version', async () => {
    const { store, runner, wfPath, prompts } = setup(LOOP, () => done('ok'), () => false);
    const task = runner.startTask({ workflowPath: wfPath, title: 'x' });
    await runner.idle();
    writeFileSync(wfPath, LOOP.replace('Fix {{ trigger.title }}', 'Repair {{ trigger.title }}'));
    runner.forgetWorkflow(wfPath);
    expect(runner.workflowChanged(store.task(task.id)!)).toBe(true);
    runner.retry(task.id, 'impl');
    await runner.idle();
    expect(prompts().at(-1)).toContain('Fix x');
    runner.refreshWorkflow(task.id);
    runner.retry(task.id, 'impl');
    await runner.idle();
    expect(prompts().at(-1)).toContain('Repair x');
  });

  it('refuses the new version when it has no step where the task is', async () => {
    const { runner, wfPath } = setup(LOOP, () => done('ok'), () => false);
    const task = runner.startTask({ workflowPath: wfPath, title: 'x' });
    await runner.idle();
    writeFileSync(wfPath, 'name: Fix\nsteps:\n  other:\n    use: human\n    question: q\n    on: { approved: end }\n');
    expect(() => runner.refreshWorkflow(task.id)).toThrow(/has no step "verify"/);
  });

  it('holds your message to a waiting agent until a slot is free', async () => {
    const { store, runner, wfPath, fake } = setup(LOOP, (text, n, opts) => (text.includes('go on') ? done('ok') : text.startsWith('Fix busy') ? null : 'Which one?\n\nOUTCOME: needs_you'));
    const waiting = runner.startTask({ workflowPath: wfPath, title: 'a' });
    await waitFor(() => store.task(waiting.id)!.status === 'needs_you');
    const b1 = runner.startTask({ workflowPath: wfPath, title: 'busy 1' });
    const b2 = runner.startTask({ workflowPath: wfPath, title: 'busy 2' });
    await waitFor(() => store.runsByStatus('running').length === 2);
    await runner.message(waiting.id, 'go on', 'chat');
    expect(fake.sent.some((s) => s.text === 'go on')).toBe(false);
    expect(store.events(waiting.id).some((e) => e.payload.includes('slots are busy'))).toBe(true);
    runner.stop(b1.id);
    await waitFor(() => fake.sent.some((s) => s.text === 'go on'));
    runner.stop(b2.id);
  });

  it('runs no more tasks of one workflow at a time than its concurrency', async () => {
    const { store, runner, wfPath } = setup('concurrency: 1\n' + LOOP, () => null);
    runner.startTask({ workflowPath: wfPath, title: 'a' });
    runner.startTask({ workflowPath: wfPath, title: 'b' });
    await new Promise((r) => setTimeout(r, 20));
    expect(store.runsByStatus('running')).toHaveLength(1);
    expect(store.runsByStatus('queued')).toHaveLength(1);
  });

  it('records what each run cost, across a resumed session', async () => {
    // Claude Code reports a running total for each process. The second turn is in the same process.
    const { store, runner, wfPath } = setup(LOOP, (text, n) =>
      n === 1 ? { text: 'Which?\n\nOUTCOME: needs_you', usage: { totalCostUsd: 0.4, tokensIn: 100, tokensOut: 10 } }
        : n === 2 ? { text: done('ok'), usage: { totalCostUsd: 0.5, tokensIn: 50, tokensOut: 5 } }
          : { text: 'Because.', usage: { totalCostUsd: 0.2, tokensIn: 20, tokensOut: 2 } });
    const task = runner.startTask({ workflowPath: wfPath, title: 'x' });
    await waitFor(() => store.task(task.id)!.status === 'needs_you');
    await runner.message(task.id, 'the first', 'chat');
    await runner.idle();
    const run = store.runsForTask(task.id)[0];
    expect(run.tokens_in).toBe(150);
    expect(run.cost_usd).toBeCloseTo(0.5);
    // A chat with the finished run resumes it in a new process, which counts from zero again.
    await runner.message(task.id, 'why?', 'chat', { runId: run.id });
    await waitFor(() => (store.run(run.id)!.tokens_out ?? 0) > 15);
    expect(store.run(run.id)!.cost_usd).toBeCloseTo(0.7);
    expect(store.run(run.id)!.tokens_out).toBe(17);
  });

  it('stops agent work when the task reaches its budget', async () => {
    const { store, runner, wfPath } = setup('budget_usd: 1\n' + LOOP, () => ({ text: done('tried'), usage: { totalCostUsd: 0.6, tokensIn: 1, tokensOut: 1 } }), () => false);
    const task = runner.startTask({ workflowPath: wfPath, title: 'x' });
    await runner.idle();
    const t = store.task(task.id)!;
    expect(t.status).toBe('needs_you');
    expect(t.inbox_reason).toBe('over_budget');
    const impl = store.runsForTask(task.id).filter((r) => r.step_id === 'impl');
    expect(impl).toHaveLength(3);
    expect(impl[2].outcome).toBe('over_budget');
  });

  it('archives a finished task and refuses to retry it', async () => {
    const { store, runner, wfPath } = setup(LOOP, () => done('ok'));
    const task = runner.startTask({ workflowPath: wfPath, title: 'x' });
    await runner.idle();
    expect(() => runner.archive(task.id)).not.toThrow();
    expect(store.task(task.id)!.archived_at).not.toBeNull();
    expect(() => runner.retry(task.id, 'impl')).toThrow(/archived/);
    runner.archive(task.id, false);
    expect(store.task(task.id)!.archived_at).toBeNull();
  });

  it('runs no agent in another folder when the worktree is gone', async () => {
    const { store, runner, wfPath } = setup(LOOP, () => done('ok'), () => true, join(tmpdir(), 'orstra-gone-' + Date.now()));
    const task = runner.startTask({ workflowPath: wfPath, title: 'x' });
    await runner.idle();
    expect(store.runsForTask(task.id)[0].outcome).toBe('cant_do');
  });

  it('runs the Simple workflow Orstra ships: waits in Todo, works, then waits in In review', async () => {
    const simple = readFileSync(fileURLToPath(new URL('../../../workflows/simple.yaml', import.meta.url)), 'utf8');
    const { store, runner, wfPath, prompts } = setup(simple, () => done('did it'));
    const task = runner.startTask({ workflowPath: wfPath, title: 'Rename the menu' });
    await runner.idle();
    expect(store.task(task.id)).toMatchObject({ status: 'needs_you', inbox_reason: 'decision', current_step: 'todo' });
    expect(prompts()).toHaveLength(0);
    runner.decide(store.runsForTask(task.id)[0].id, 'start');
    await runner.idle();
    expect(prompts()[0]).toContain('Rename the menu');
    expect(store.task(task.id)).toMatchObject({ status: 'needs_you', current_step: 'review' });
    const review = store.runsForTask(task.id).find((r) => r.step_id === 'review')!;
    runner.decide(review.id, 'approved');
    expect(store.task(task.id)!.status).toBe('done');
  });

  it('reopens a done task: a re-run of its first agent step, with your note', async () => {
    const simple = readFileSync(fileURLToPath(new URL('../../../workflows/simple.yaml', import.meta.url)), 'utf8');
    const { store, runner, wfPath, prompts } = setup(simple, () => done('did it'));
    const task = runner.startTask({ workflowPath: wfPath, title: 'Rename the menu' });
    await runner.idle();
    runner.decide(store.runsForTask(task.id)[0].id, 'start');
    await runner.idle();
    runner.decide(store.runsForTask(task.id).find((r) => r.step_id === 'review')!.id, 'approved');
    expect(store.task(task.id)!.status).toBe('done');
    runner.retry(task.id, 'work', 'Also rename the footer');
    await runner.idle();
    expect(prompts()).toHaveLength(2);
    expect(prompts()[1]).toContain('Also rename the footer');
    expect(store.task(task.id)).toMatchObject({ status: 'needs_you', current_step: 'review' });
  });
});

const SHOT = `
name: Shot
steps:
  impl:
    use: agent
    prompt: Fix {{ trigger.title }}
    artifacts:
      - name: screen
        path: out/*.png
        required: true
    next: end
`;

describe('Runner artifacts', () => {
  it('collects what the run produced and keeps it outside the worktree', async () => {
    let dir = '';
    const s = setup(SHOT, () => {
      mkdirSync(join(dir, 'out'), { recursive: true });
      writeFileSync(join(dir, 'out/shot.png'), 'png bytes');
      return done('added the empty state');
    });
    dir = s.dir;
    const task = s.runner.startTask({ workflowPath: s.wfPath, title: 'empty state' });
    await s.runner.idle();

    expect(s.store.task(task.id)!.status).toBe('done');
    const rows = s.store.artifactsForTask(task.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('shot.png');
    expect(rows[0].mime).toBe('image/png');
    expect(rows[0].label).toBe('screen');
    expect(rows[0].step_id).toBe('impl');
    expect(rows[0].path!.startsWith(s.artifactsRoot)).toBe(true);
    expect(readFileSync(rows[0].path!, 'utf8')).toBe('png bytes');
    expect(s.prompts()[0]).toContain('out/*.png (required)');
  });

  it('runs the step once more when a required file is absent, then asks you', async () => {
    const s = setup(SHOT, () => done('forgot the screenshot'));
    const task = s.runner.startTask({ workflowPath: s.wfPath, title: 'empty state' });
    await s.runner.idle();

    const t = s.store.task(task.id)!;
    expect(t.status).toBe('needs_you');
    expect(t.inbox_reason).toBe('missing_artifact');
    expect(t.current_step).toBe('impl');
    expect(s.store.runsForTask(task.id).map((r) => `${r.step_id}#${r.attempt}`)).toEqual(['impl#1', 'impl#2']);
    expect(s.prompts()[1]).toContain('no file that matches out/*.png');
  });

  it('takes the file on the second attempt and moves on', async () => {
    let dir = '';
    const s = setup(SHOT, (_t, n) => {
      if (n > 1) {
        mkdirSync(join(dir, 'out'), { recursive: true });
        writeFileSync(join(dir, 'out/shot.png'), 'late');
      }
      return done(`attempt ${n}`);
    });
    dir = s.dir;
    const task = s.runner.startTask({ workflowPath: s.wfPath, title: 'empty state' });
    await s.runner.idle();

    expect(s.store.task(task.id)!.status).toBe('done');
    // Attempt 1 left the gap on the record; attempt 2 produced the file.
    expect(s.store.artifactsForTask(task.id).map((a) => `${a.state}:${a.name}`)).toEqual(['missing:out/*.png', 'saved:shot.png']);
  });

  it('does not demand a file from a run that failed', async () => {
    const s = setup(SHOT, () => 'could not do it\n\nOUTCOME: cant_do');
    const task = s.runner.startTask({ workflowPath: s.wfPath, title: 'empty state' });
    await s.runner.idle();

    const t = s.store.task(task.id)!;
    expect(t.inbox_reason).toBe('cant_do');
    expect(s.store.runsForTask(task.id)).toHaveLength(1);
  });
});

const HANDOFF = `
name: Plan then build
steps:
  plan:
    use: agent
    prompt: Plan it
    next: build
  build:
    use: agent
    prompt: "Build it from {{ steps.plan.artifacts }}"
    next: end
`;

describe('Runner artifacts between steps', () => {
  it('keeps what any step writes to .orstra/artifacts/, with no workflow change', async () => {
    let dir = '';
    const s = setup(HANDOFF, (_t, n) => {
      if (n === 1) {
        mkdirSync(join(dir, '.orstra/artifacts'), { recursive: true });
        writeFileSync(join(dir, '.orstra/artifacts/plan.md'), '# Plan\n1. empty state');
      }
      return done(`step ${n}`);
    });
    dir = s.dir;
    const task = s.runner.startTask({ workflowPath: s.wfPath, title: 'empty state' });
    await s.runner.idle();

    const rows = s.store.artifactsForTask(task.id);
    expect(rows.map((a) => `${a.step_id}:${a.state}:${a.name}`)).toEqual(['plan:saved:plan.md']);
    expect(rows[0].label).toBe('artifacts');
  });

  it('hands the earlier steps’ artifacts to the next run, in the worktree and in its prompt', async () => {
    let dir = '';
    let seen = '';
    const s = setup(HANDOFF, (_t, n) => {
      if (n === 1) {
        mkdirSync(join(dir, '.orstra/artifacts'), { recursive: true });
        writeFileSync(join(dir, '.orstra/artifacts/plan.md'), '# Plan\n1. empty state');
      } else {
        seen = readFileSync(join(dir, '.orstra/inputs/plan/plan.md'), 'utf8');
      }
      return done(`step ${n}`);
    });
    dir = s.dir;
    s.runner.startTask({ workflowPath: s.wfPath, title: 'empty state' });
    await s.runner.idle();

    expect(seen).toBe('# Plan\n1. empty state');
    const build = s.prompts()[1];
    expect(build).toContain('Build it from .orstra/inputs/plan/plan.md');
    expect(build).toContain('- .orstra/inputs/plan/plan.md (plan, 1 KB)');
    expect(s.prompts()[0]).toContain('write it under .orstra/artifacts/');
  });

  it('records no gap when a step leaves nothing and declared nothing', async () => {
    const s = setup(HANDOFF, (_t, n) => done(`step ${n}`));
    const task = s.runner.startTask({ workflowPath: s.wfPath, title: 'quiet' });
    await s.runner.idle();
    expect(s.store.artifactsForTask(task.id)).toEqual([]);
  });
});
