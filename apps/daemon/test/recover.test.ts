import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/db.ts';
import { Runner } from '../src/runner.ts';
import type { Executors, LiveSession, SessionOptions } from '../src/executors.ts';
import type { ProcessEnv, StopResult } from '../src/process.ts';

const WF = 'name: X\nsteps:\n  work:\n    use: agent\n    prompt: go\n    next: end\n';
/** The pid the first daemon's agent runs under. */
const AGENT_PID = 4242;

/** A machine the test describes: which boot it is on, and which pids run since when. */
const machine = (boot: string, started: Record<number, string>): ProcessEnv => ({
  bootId: () => boot,
  self: () => 1000,
  startedAt: (pid) => started[pid] ?? null,
});

/** A session that never answers, so the run stays open the way a crash leaves it. */
function idleExecutors(pid?: number) {
  const opened: SessionOptions[] = [];
  const exec: Executors = {
    session(_kind, opts): LiveSession {
      opened.push(opts);
      return { pid, send() {}, interrupt() {}, end() {}, kill() {}, closed: new Promise(() => {}) };
    },
    async gate() {
      return { pass: true, output: '' };
    },
    async ask() {
      return '';
    },
  };
  return { exec, opened };
}

/**
 * A daemon that started an agent and then died, and the daemon that comes up next over the same
 * database. `before` is the machine the first one ran on, `after` the machine the second sees.
 */
async function restart(opts: { before: ProcessEnv; after: ProcessEnv; git?: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), 'orstra-rec-'));
  if (opts.git) {
    const run = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: 'ignore' });
    run('init', '-q');
    writeFileSync(join(dir, 'a.txt'), 'one');
    run('add', '-A');
    run('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'first');
  }
  const wf = join(dir, 'wf.yaml');
  writeFileSync(wf, WF);
  const store = new Store(':memory:');

  const first = idleExecutors(AGENT_PID);
  const dead = new Runner(store, first.exec, { slots: 1, createWorktree: () => dir, processEnv: opts.before });
  const task = dead.startTask({ workflowPath: wf, title: 'x' });
  // Let pump() reach openSession, which stamps the row with the agent's process.
  await new Promise((r) => setTimeout(r, 30));
  const runId = store.runsForTask(task.id)[0].id;

  // The daemon dies here. Nothing releases the run, and nothing clears the stamp.
  const stopped: number[] = [];
  const next = idleExecutors();
  const runner = new Runner(store, next.exec, {
    slots: 1,
    createWorktree: () => dir,
    processEnv: opts.after,
    sweepGraceMs: 10,
    // Never signal a real process from a test.
    stopProcess: async (pid): Promise<StopResult> => (stopped.push(pid), 'exited'),
  });
  return { store, runner, taskId: task.id, runId, stopped, opened: next.opened };
}

const systemText = (store: Store, taskId: string) =>
  store
    .events(taskId)
    .filter((e) => e.kind === 'system')
    .map((e) => (JSON.parse(e.payload) as { text: string }).text)
    .join('\n');

/** The same machine, same boot: the agent process is still there. */
const sameBox = { before: machine('boot-1', { [AGENT_PID]: 'nine' }), after: machine('boot-1', { [AGENT_PID]: 'nine' }) };

describe('the stamp openSession writes', () => {
  it('names the agent process, so a later daemon can find it', async () => {
    const t = await restart(sameBox);
    const run = t.store.run(t.runId)!;
    expect(run.agent_pid).toBe(AGENT_PID);
    expect(run.agent_boot_id).toBe('boot-1');
    expect(run.agent_started_at).toBe('nine');
  });
});

describe('recover', () => {
  it('leaves an agent run waiting, so your next message resumes the session', async () => {
    const t = await restart(sameBox);
    t.runner.recover();
    const run = t.store.run(t.runId)!;
    expect(run.status).toBe('waiting');
    expect(run.session_id).toBeTruthy();
    expect(systemText(t.store, t.taskId)).toContain('Orstra restarted mid-run');
  });

  it('stops an agent that outlived the daemon, and says which process it was', async () => {
    const t = await restart(sameBox);
    t.runner.recover();
    await new Promise((r) => setTimeout(r, 20));
    expect(t.stopped).toEqual([AGENT_PID]);
    const text = systemText(t.store, t.taskId);
    expect(text).toContain('Claude Code was still working');
    expect(text).toContain(`pid ${AGENT_PID}`);
  });

  it('stops nothing when the agent process is already gone', async () => {
    const t = await restart({ before: machine('boot-1', { [AGENT_PID]: 'nine' }), after: machine('boot-1', {}) });
    t.runner.recover();
    await new Promise((r) => setTimeout(r, 20));
    expect(t.stopped).toEqual([]);
    expect(systemText(t.store, t.taskId)).not.toContain('was still working');
  });

  it('stops nothing after a reboot, because that pid is somebody else now', async () => {
    const t = await restart({ before: machine('boot-1', { [AGENT_PID]: 'nine' }), after: machine('boot-2', { [AGENT_PID]: 'nine' }) });
    t.runner.recover();
    await new Promise((r) => setTimeout(r, 20));
    expect(t.stopped).toEqual([]);
  });

  it('stops nothing when the system gave that pid to someone else', async () => {
    const t = await restart({ before: machine('boot-1', { [AGENT_PID]: 'nine' }), after: machine('boot-1', { [AGENT_PID]: 'much later' }) });
    t.runner.recover();
    await new Promise((r) => setTimeout(r, 20));
    expect(t.stopped).toEqual([]);
  });

  it('clears the stamp, so a later restart does not chase the same process twice', async () => {
    const t = await restart(sameBox);
    t.runner.recover();
    const run = t.store.run(t.runId)!;
    expect(run.agent_pid).toBeNull();
    expect(run.agent_boot_id).toBeNull();
    expect(run.agent_started_at).toBeNull();
  });
});

describe('a message to a session a stray process still holds', () => {
  it('is refused, and names the process to deal with', async () => {
    const t = await restart(sameBox);
    // The run waits for you and the stamp still names a live process: the sweep never ran, or
    // somebody started that agent by hand.
    t.store.updateRun(t.runId, { status: 'waiting', wait_reason: 'paused' });

    await expect(t.runner.message(t.taskId, 'carry on', 'chat')).rejects.toThrow(/still holds this session/);
    expect(t.opened.length).toBe(0);
    expect(systemText(t.store, t.taskId)).toContain(`pid ${AGENT_PID}`);
  });

  it('goes through once that process is gone', async () => {
    const t = await restart({ before: machine('boot-1', { [AGENT_PID]: 'nine' }), after: machine('boot-1', {}) });
    const sessionId = t.store.run(t.runId)!.session_id;
    t.store.updateRun(t.runId, { status: 'waiting', wait_reason: 'paused' });

    await t.runner.message(t.taskId, 'carry on', 'chat');
    expect(t.opened.length).toBe(1);
    expect(t.opened[0]).toMatchObject({ sessionId, resume: true });
  });
});

describe('the commit range a run leaves', () => {
  it('records the worktree\u2019s commit when the run starts, and when a restart finds it open', async () => {
    const t = await restart({ ...sameBox, git: true });
    const before = t.store.run(t.runId)!.head_before;
    expect(before).toMatch(/^[0-9a-f]{40}$/);
    expect(t.store.run(t.runId)!.head_after).toBeNull();

    t.runner.recover();
    const run = t.store.run(t.runId)!;
    // Nothing was committed while the agent worked, so the range is empty, and it is readable.
    expect(run.head_after).toBe(before);
  });

  it('records nothing for a worktree that is not a repository', async () => {
    const t = await restart(sameBox);
    expect(t.store.run(t.runId)!.head_before).toBeNull();
    t.runner.recover();
    expect(t.store.run(t.runId)!.head_after).toBeNull();
  });
});

describe('what the restart says about the lost turn', () => {
  it('names the commits the agent had already made', async () => {
    const t = await restart({ ...sameBox, git: true });
    // The agent committed while it worked, then the daemon died.
    const dir = t.store.task(t.taskId)!.worktree!;
    const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: 'ignore' });
    writeFileSync(join(dir, 'b.txt'), 'two');
    git('add', '-A');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'the work');

    t.runner.recover();
    expect(systemText(t.store, t.taskId)).toContain('It left 1 commit on the branch');
  });

  it('says nothing about commits when the agent made none', async () => {
    const t = await restart({ ...sameBox, git: true });
    t.runner.recover();
    expect(systemText(t.store, t.taskId)).not.toContain('on the branch');
  });
});
