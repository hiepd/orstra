import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/db.ts';
import { MAX_RESUMES, Runner } from '../src/runner.ts';
import type { Executors, LiveSession, SessionOptions } from '../src/executors.ts';
import type { LogEntry } from '../src/sessionLog.ts';

/**
 * A daemon dies in the middle of an agent's turn, and the next one replays the agent's session log.
 * The test plays both daemons over 1 database, and writes the session log the way Claude Code does.
 */

const WF = 'name: X\nsteps:\n  work:\n    use: agent\n    prompt: go\n    next: check\n  check:\n    use: gate\n    run: ["true"]\n    on: { pass: end, fail: work }\n';

/** Sessions that never answer on their own. The test drives them through the options they got. */
function quietExecutors() {
  const opened: SessionOptions[] = [];
  const sent: string[] = [];
  let gates = 0;
  const exec: Executors = {
    session(_kind, opts): LiveSession {
      opened.push(opts);
      return { send: (t) => void sent.push(t), interrupt() {}, end() {}, kill() {}, closed: new Promise(() => {}) };
    },
    async gate() {
      gates++;
      return { pass: true, output: '' };
    },
    async ask() {
      return '';
    },
  };
  return { exec, opened, sent, gates: () => gates };
}

const user = (uuid: string, content: unknown): LogEntry => ({ type: 'user', uuid, message: { role: 'user', content } });
const said = (uuid: string, text: string, stop: string | null = null): LogEntry => ({ type: 'assistant', uuid, message: { id: `m-${uuid}`, role: 'assistant', stop_reason: stop, content: [{ type: 'text', text }] } });
const call = (uuid: string, id: string, command: string): LogEntry => ({ type: 'assistant', uuid, message: { id: `m-${uuid}`, role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } });
const result = (uuid: string, id: string): LogEntry => user(uuid, [{ type: 'tool_result', tool_use_id: id, content: 'ok' }]);

/**
 * Start a task, let the first daemon store the lines in `seen`, then let it die. The session log holds
 * `log`: what the agent wrote, including what came after the daemon died.
 */
async function crash(seen: LogEntry[], log: LogEntry[], opts: { resumedAt?: number[] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'orstra-replay-'));
  const wf = join(dir, 'wf.yaml');
  writeFileSync(wf, WF);
  const config = join(dir, 'claude');
  const store = new Store(':memory:');

  const first = quietExecutors();
  const dead = new Runner(store, first.exec, { slots: 1, createWorktree: () => dir, claudeConfigDir: config });
  const task = dead.startTask({ workflowPath: wf, title: 'x' });
  await new Promise((r) => setTimeout(r, 30));
  const run = store.runsForTask(task.id)[0];
  // The first daemon reads the stream: each line with its uuid, as Claude Code sends it.
  const live = first.opened[0];
  for (const e of seen) {
    const { readClaudeLine } = await import('../src/executors.ts');
    readClaudeLine(JSON.stringify(e), { onEvent: live.onEvent, onText: () => {}, onResult: () => {}, onLine: live.onLog });
  }
  if (opts.resumedAt) store.updateRun(run.id, { resumed_at: JSON.stringify(opts.resumedAt) });

  mkdirSync(join(config, 'projects', 'wt'), { recursive: true });
  writeFileSync(join(config, 'projects', 'wt', `${run.session_id}.jsonl`), log.map((e) => JSON.stringify(e)).join('\n') + '\n');

  // The daemon dies here. The next one comes up over the same database.
  const next = quietExecutors();
  const runner = new Runner(store, next.exec, { slots: 1, createWorktree: () => dir, claudeConfigDir: config, turnGraceMs: 5 });
  return { store, runner, taskId: task.id, runId: run.id, sessionId: run.session_id, next };
}

const chat = (store: Store, taskId: string) =>
  store
    .events(taskId)
    .filter((e) => e.kind !== 'you')
    .map((e) => {
      const p = JSON.parse(e.payload);
      return e.kind === 'tool' ? `tool:${p.summary}` : e.kind === 'tool_result' ? `result:${p.callId}` : `${e.kind}:${p.text ?? ''}`;
    })
    // The first line of every task says which workflow it started.
    .filter((line) => !line.startsWith('system:Started '));

describe('the checkpoint while the agent works', () => {
  it('stores each line’s events with the line’s uuid', async () => {
    const t = await crash([user('u0', 'go'), said('u1', 'I look first.'), call('u2', 't1', 'ls')], []);
    expect(t.store.run(t.runId)!.log_uuid).toBe('u2');
    expect(chat(t.store, t.taskId)).toEqual(['message:I look first.', 'tool:ls']);
  });
});

describe('recover, with the session log as the WAL', () => {
  it('replays what the agent wrote after the last stored line, once, and resumes a cut tool call', async () => {
    const seen = [user('u0', 'go'), said('u1', 'I look first.')];
    const t = await crash(seen, [...seen, call('u2', 't1', 'ls'), result('u3', 't1'), call('u4', 't2', 'npm test')]);
    await t.runner.recover();

    expect(chat(t.store, t.taskId).slice(0, 5)).toEqual(['message:I look first.', 'tool:ls', 'result:t1', 'tool:npm test', 'system:Orstra restarted while Claude Code ran Bash: npm test. Orstra read 3 more steps from the session log. Claude Code continues, and checks that call first.']);
    expect(t.store.run(t.runId)!.log_uuid).toBe('u4');
    expect(t.store.run(t.runId)!.status).toBe('running');
    expect(t.next.opened).toHaveLength(1);
    expect(t.next.opened[0]).toMatchObject({ sessionId: t.sessionId, resume: true });
    expect(t.next.sent[0]).toMatch(/Bash \(npm test\)\. The call may not have finished/);
  });

  it('resumes with a plain note when the agent was between 2 actions', async () => {
    const seen = [user('u0', 'go'), call('u1', 't1', 'ls'), result('u2', 't1')];
    const t = await crash(seen, seen);
    await t.runner.recover();
    expect(t.next.sent[0]).toMatch(/^Orstra restarted while you worked\. Your session is intact\./);
    expect(chat(t.store, t.taskId).at(-1)).toBe('system:Orstra restarted mid-run. Claude Code continues where it stopped.');
  });

  it('goes on to the next step when the turn had ended, without opening the session again', async () => {
    const seen = [user('u0', 'go'), call('u1', 't1', 'ls')];
    const t = await crash(seen, [...seen, result('u2', 't1'), said('u3', 'All done.\n## Progress\nDid: it\nOUTCOME: done', 'end_turn')]);
    await t.runner.recover();
    await t.runner.idle();

    expect(t.next.opened).toHaveLength(0);
    const runs = t.store.runsForTask(t.taskId);
    expect(runs[0]).toMatchObject({ status: 'done', outcome: 'done' });
    expect(t.next.gates()).toBe(1);
    expect(t.store.task(t.taskId)!.status).toBe('done');
  });

  it('asks for the OUTCOME line when the ended turn has none', async () => {
    const seen = [user('u0', 'go')];
    const t = await crash(seen, [...seen, said('u1', 'I think it works.', 'end_turn')]);
    await t.runner.recover();
    expect(t.next.opened[0]).toMatchObject({ resume: true });
    expect(t.next.sent[0]).toMatch(/no OUTCOME line/);
  });

  it('resumes a run that waited on a permission question, so the agent asks again', async () => {
    const seen = [user('u0', 'go'), call('u1', 't1', 'rm -rf build')];
    const t = await crash(seen, seen);
    t.store.updateRun(t.runId, { status: 'waiting', wait_reason: 'permission' });
    await t.runner.recover();
    expect(t.store.run(t.runId)!.status).toBe('running');
    expect(t.next.sent[0]).toMatch(/Bash \(rm -rf build\)\. The call may not have finished/);
  });

  it('pauses instead of resuming once restarts come too often', async () => {
    const seen = [user('u0', 'go')];
    const now = Date.now();
    const t = await crash(seen, seen, { resumedAt: Array.from({ length: MAX_RESUMES }, (_, i) => now - i * 1000) });
    await t.runner.recover();
    expect(t.next.opened).toHaveLength(0);
    expect(t.store.run(t.runId)).toMatchObject({ status: 'waiting', wait_reason: 'paused' });
    expect(chat(t.store, t.taskId).at(-1)).toMatch(/restarted mid-run 4 times in 10 minutes/);
  });

  it('still resumes when Claude Code left no log', async () => {
    const t = await crash([user('u0', 'go')], []);
    // No file at all, as with a session whose log was deleted.
    t.store.updateRun(t.runId, { session_id: 'gone' });
    await t.runner.recover();
    expect(t.next.opened[0]).toMatchObject({ sessionId: 'gone', resume: true });
    expect(t.next.sent[0]).toMatch(/Your session is intact/);
  });
});

describe('recover, for a check that was running', () => {
  it('runs it again from the start', async () => {
    const seen = [user('u0', 'go')];
    const t = await crash(seen, seen);
    // Move the task on to its check, and leave the check running the way a crash does.
    const run = t.store.run(t.runId)!;
    t.store.updateRun(run.id, { status: 'done', outcome: 'done', ended_at: Date.now() });
    const gate = { ...run, id: 'r-gate', step_id: 'check', kind: 'gate', status: 'running' as const, session_id: null, created_at: Date.now() + 1 };
    t.store.insertRun(gate);
    await t.runner.recover();
    await t.runner.idle();
    expect(t.next.gates()).toBe(1);
    expect(t.store.run('r-gate')).toMatchObject({ status: 'done', outcome: 'pass' });
    expect(chat(t.store, t.taskId)).toContain('system:Orstra restarted while this check ran. It runs again from the start.');
  });
});
