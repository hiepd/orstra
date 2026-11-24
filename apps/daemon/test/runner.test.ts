import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/db.ts';
import { Runner } from '../src/runner.ts';
import { makeViews } from '../src/server.ts';
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

function setup(yaml: string, reply: (text: string, n: number, opts: SessionOptions) => string | null, gate: (n: number) => boolean = () => true, worktree?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'orstra-test-'));
  const wfPath = join(dir, 'wf.yaml');
  writeFileSync(wfPath, yaml);
  const fake = fakeExecutors(reply, gate);
  const store = new Store(':memory:');
  const runner = new Runner(store, fake.exec, { slots: 2, createWorktree: () => worktree ?? dir, turnGraceMs: 0 });
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

  it('refuses a decision while an agent run works, so approval cannot merge a diff in flight', async () => {
    const { store, runner, wfPath } = setup(REVIEW, () => done('first pass'));
    const task = runner.startTask({ workflowPath: wfPath, title: 'guard' });
    await runner.idle();
    const work = store.runsForTask(task.id)[0];
    const review = store.runsForTask(task.id).find((r) => r.kind === 'human')!;

    // The state a stale page can send: the decision still waits, and the agent works again.
    store.updateRun(work.id, { status: 'running', outcome: null, ended_at: null });
    expect(() => runner.decide(review.id, 'close')).toThrow(/working/);

    store.updateRun(work.id, { status: 'done', outcome: 'done' });
    runner.decide(review.id, 'close');
    await runner.idle();
    expect(store.task(task.id)!.status).toBe('done');
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
