import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/db.ts';
import { Runner } from '../src/runner.ts';
import { claudeArgs, PERMISSION_TOOL, type Executors, type LiveSession, type SessionOptions } from '../src/executors.ts';
import { ask, handle, setWriter } from '../src/perm-mcp.ts';

const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

describe('claudeArgs and permission questions', () => {
  it('sends permission questions to Orstra for a task run', () => {
    const args = claudeArgs({ sessionId: 's', resume: false, runId: 'r-1' });
    expect(after(args, '--permission-prompt-tool')).toBe(PERMISSION_TOOL);
    const cfg = JSON.parse(after(args, '--mcp-config'));
    expect(cfg.mcpServers.orstra_perm.env.ORSTRA_RUN_ID).toBe('r-1');
    expect(args).not.toContain('--strict-mcp-config');
  });

  it('does not when the setting is off, or for the chief of staff', () => {
    expect(claudeArgs({ sessionId: 's', resume: false, runId: 'r-1' }, { askPermission: false })).not.toContain('--permission-prompt-tool');
    expect(claudeArgs({ sessionId: 's', resume: false, runId: 'r-1', toolArgs: ['--x'] })).not.toContain('--permission-prompt-tool');
  });
});

describe('perm-mcp', () => {
  it('returns the daemon answer as one text block, as Claude Code wants it', async () => {
    const out: any[] = [];
    setWriter((m) => out.push(m));
    // No daemon listens here, so the tool must deny with a reason, never hang.
    process.env.ORSTRA_DAEMON_URL = 'http://127.0.0.1:9';
    await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'permission_prompt', arguments: { tool_name: 'WebFetch', input: { url: 'x' } } } });
    const text = JSON.parse(out[0].result.content[0].text);
    expect(text.behavior).toBe('deny');
  });

  it('keeps asking until the daemon has an answer', async () => {
    let waits = 0;
    const http = async (path: string) => {
      if (path === '/api/permissions') return { id: 'p1' };
      waits++;
      return waits < 3 ? { decision: null } : { decision: { behavior: 'allow', updatedInput: { url: 'x' } } };
    };
    const d = await ask('WebFetch', { url: 'x' }, http);
    expect(d.behavior).toBe('allow');
    expect(waits).toBe(3);
  });
});

/** An agent whose first turn never ends on its own: it waits, like a tool call that waits for permission. */
function quietExecutors() {
  const sessions: SessionOptions[] = [];
  const exec: Executors = {
    session(_k, opts): LiveSession {
      sessions.push(opts);
      let done!: (r: { ok: boolean }) => void;
      const closed = new Promise<{ ok: boolean }>((r) => (done = r));
      return { send() {}, interrupt() {}, end: () => done({ ok: true }), kill: () => done({ ok: true }), closed };
    },
    async gate() { return { pass: true, output: '' }; },
    async ask() { return ''; },
  };
  return { exec, sessions };
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'orstra-perm-'));
  const wfPath = join(dir, 'wf.yaml');
  writeFileSync(wfPath, 'name: P\nsteps:\n  work:\n    use: agent\n    prompt: do it\n    next: end\n');
  const q = quietExecutors();
  const store = new Store(':memory:');
  const runner = new Runner(store, q.exec, { slots: 2, createWorktree: () => dir, turnGraceMs: 0 });
  const task = runner.startTask({ workflowPath: wfPath, title: 'x' });
  const run = store.runsForTask(task.id)[0];
  return { store, runner, task, run, q };
}

describe('Runner permission questions', () => {
  it('gives the session its run id, so its questions find the task', () => {
    const { run, q } = setup();
    expect(q.sessions[0].runId).toBe(run.id);
  });

  it('puts the question in the Inbox and lets the run go on when you allow it', async () => {
    const { store, runner, task, run } = setup();
    const { id, decision } = runner.requestPermission(run.id, 'WebFetch', { url: 'https://example.com' });
    expect(decision).toBeUndefined();
    expect(store.task(task.id)!.inbox_reason).toBe('permission');
    expect(runner.pendingPermission(task.id)?.summary).toBe('https://example.com');
    const wait = runner.waitPermission(id, 1000);
    runner.answerPermission(id, true);
    expect((await wait)?.behavior).toBe('allow');
    expect(store.task(task.id)!.status).toBe('running');
    expect(store.run(run.id)!.status).toBe('running');
  });

  it('says no with your reason', async () => {
    const { runner, run } = setup();
    const { id } = runner.requestPermission(run.id, 'Bash', { command: 'rm -rf build' });
    runner.answerPermission(id, false, { message: 'Use npm run clean.' });
    expect(await runner.waitPermission(id)).toEqual({ behavior: 'deny', message: 'Use npm run clean.' });
  });

  it('lets a tool you allowed for the task pass without a question', () => {
    const { store, runner, task, run } = setup();
    const { id } = runner.requestPermission(run.id, 'WebFetch', { url: 'a' });
    runner.answerPermission(id, true, { always: true });
    const again = runner.requestPermission(run.id, 'WebFetch', { url: 'b' });
    expect(again.decision?.behavior).toBe('allow');
    expect(store.task(task.id)!.status).toBe('running');
  });

  it('returns "still open" when no answer comes in time', async () => {
    const { runner, run } = setup();
    const { id } = runner.requestPermission(run.id, 'WebFetch', { url: 'a' });
    expect(await runner.waitPermission(id, 10)).toBeNull();
  });

  it('denies a question from a run that is not active', () => {
    const { runner, task, run } = setup();
    runner.stop(task.id);
    expect(runner.requestPermission(run.id, 'Bash', {}).decision?.behavior).toBe('deny');
  });
});
