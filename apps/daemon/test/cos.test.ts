import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ChiefOfStaff, COS_ID } from '../src/cos.ts';
import { handle, setWriter } from '../src/cos-mcp.ts';
import { COS_TOOLS } from '../src/cos-tools.ts';
import { Store } from '../src/db.ts';
import type { Executors, LiveSession, SessionOptions } from '../src/executors.ts';
import { Runner } from '../src/runner.ts';
import { makeViews } from '../src/server.ts';

const WF = `
name: Ship it
steps:
  impl:
    title: Implement
    use: agent
    prompt: Do {{ trigger.title }}
    next: approve
  approve:
    title: Approve
    use: human
    question: Good?
    on:
      approved: end
      rejected: end
`;
const done = '## Progress\nDid: it\n\nOUTCOME: done';

/**
 * Two kinds of fake sessions: task agents finish their step straight away; the chief of staff's session
 * (cwd = the cos folder) records what it was sent and answers nothing, so the test drives its tools.
 */
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'orstra-cos-'));
  const wfPath = join(dir, 'wf.yaml');
  writeFileSync(wfPath, WF);
  const cosDir = join(dir, 'cos');
  const toCos: string[] = [];
  const toAgents: string[] = [];
  const cosSessions: SessionOptions[] = [];
  const exec: Executors = {
    session(_kind, opts): LiveSession {
      let done_!: (r: { ok: boolean }) => void;
      const closed = new Promise<{ ok: boolean }>((r) => (done_ = r));
      const isCos = opts.cwd === cosDir;
      if (isCos) cosSessions.push(opts);
      return {
        send(text) {
          if (isCos) {
            toCos.push(text);
            setTimeout(() => opts.onTurn({ text: 'ok', interrupted: false, isError: false }), 1);
          } else {
            toAgents.push(text);
            setTimeout(() => opts.onTurn({ text: toAgents.length === 1 ? done : 'noted', interrupted: false, isError: false }), 1);
          }
        },
        interrupt() {},
        end() { done_({ ok: true }); },
        kill() { done_({ ok: true }); },
        closed,
      };
    },
    async gate() { return { pass: true, output: '' }; },
    async ask() { return ''; },
  };
  const store = new Store(':memory:');
  const runner = new Runner(store, exec, { slots: 2, createWorktree: () => dir, turnGraceMs: 0 });
  const cos = new ChiefOfStaff(store, runner, exec, makeViews(store, runner), { cwd: cosDir, toolArgs: ['--tools', ''] });
  runner.on('change', (e: { taskId: string }) => cos.onTaskChange(e.taskId));
  const kinds = () => store.events(COS_ID).map((e) => e.kind);
  return { store, runner, cos, wfPath, toCos, toAgents, cosSessions, kinds };
}

describe('ChiefOfStaff', () => {
  it('reads tasks by ticket and shows them as rows', async () => {
    const { runner, cos, wfPath, store } = setup();
    const t = runner.startTask({ workflowPath: wfPath, title: 'empty state', ref: 'HUB-1' });
    await runner.idle();
    const list = JSON.parse(await cos.tool('list_tasks'));
    expect(list[0]).toMatchObject({ task: 'HUB-1', status: 'needs_you', waitingFor: 'decision', step: 'Approve' });
    const one = JSON.parse(await cos.tool('get_task', { task: 'hub-1' }));
    expect(one.decision.choices).toEqual(['approved', 'rejected']);
    expect(one.runs[0].progress.did).toBe('it');
    await cos.tool('show_tasks', { title: 'Need you · 1', tasks: ['HUB-1'] });
    const ev = store.events(COS_ID).at(-1)!;
    expect(ev.kind).toBe('show');
    expect(JSON.parse(ev.payload).taskIds).toEqual([t.id]);
    await expect(cos.tool('get_task', { task: 'HUB-404' })).rejects.toThrow('No task "HUB-404"');
  });

  it('messages agents straight away when allowed, and marks the message as its own', async () => {
    const { runner, cos, wfPath, store, toAgents } = setup();
    const t = runner.startTask({ workflowPath: wfPath, title: 'x', ref: 'HUB-2' });
    await runner.idle();
    const out = await cos.tool('message_agent', { task: 'HUB-2', text: 'use the shared button' });
    expect(out).toMatch(/^Done: Sent to Claude Code on HUB-2/);
    // The decision waited, so the chat sent Implement back to the agent too. Your words still lead the message.
    expect(toAgents.at(-1)!.split('\n\n--- Orstra ---')[0]).toBe('use the shared button');
    expect(out).toContain('The task went back to Implement');
    const you = store.events(t.id).map((e) => JSON.parse(e.payload)).find((p) => p.mode === 'chat');
    expect(you).toMatchObject({ text: 'use the shared button', via: 'cos' });
  });

  it('collects gated actions from one turn into one plan, and runs them only when approved', async () => {
    const { runner, cos, wfPath, store, toCos } = setup();
    const t = runner.startTask({ workflowPath: wfPath, title: 'x', ref: 'HUB-3' });
    await runner.idle();
    cos.say('approve HUB-3 and start a follow-up');
    const a = await cos.tool('decide', { task: 'HUB-3', choice: 'approved', comment: 'ship it' });
    const b = await cos.tool('start_task', { workflow: wfPath, title: 'follow-up' });
    expect(a).toMatch(/Needs the user's OK/);
    expect(b).toMatch(/Needs the user's OK/);
    expect(store.task(t.id)!.status).toBe('needs_you'); // nothing ran yet
    const [plan] = cos.view().plans;
    expect(plan.status).toBe('pending');
    expect(plan.actions).toEqual(['Answer HUB-3’s decision: approved, with “ship it”', 'Start a task: “follow-up” · Ship it']);

    await cos.approve(plan.id);
    await runner.idle();
    await new Promise((r) => setTimeout(r, 5));
    expect(store.task(t.id)!.status).toBe('done');
    expect(store.tasks().some((x) => x.title === 'follow-up')).toBe(true);
    expect(cos.view().plans[0]).toMatchObject({ status: 'approved' });
    expect(toCos.at(-1)).toMatch(/^\[Orstra\] The user approved plan/);
    await expect(cos.approve(plan.id)).rejects.toThrow('isn’t waiting');
  });

  it('a declined plan does nothing and is mentioned with the next message', async () => {
    const { runner, cos, wfPath, store, toCos } = setup();
    const t = runner.startTask({ workflowPath: wfPath, title: 'x', ref: 'HUB-4' });
    await runner.idle();
    await cos.tool('stop_task', { task: 'HUB-4' });
    const [plan] = cos.view().plans;
    cos.decline(plan.id);
    expect(store.task(t.id)!.status).toBe('needs_you');
    cos.say('ok what now');
    expect(toCos.at(-1)).toMatch(/said "Not now" to plan .*Stop HUB-4[\s\S]*ok what now$/);
  });

  it('permissions decide what needs an OK', async () => {
    const { runner, cos, wfPath, toAgents } = setup();
    runner.startTask({ workflowPath: wfPath, title: 'x', ref: 'HUB-5' });
    await runner.idle();
    cos.setPermission('msg', false);
    expect(await cos.tool('message_agent', { task: 'HUB-5', text: 'hi' })).toMatch(/Needs the user's OK/);
    expect(toAgents).not.toContain('hi');
    cos.setPermission('start', true);
    expect(await cos.tool('start_task', { workflow: wfPath, title: 'now' })).toMatch(/^Done: Started/);
    expect(() => cos.setPermission('decide' as never, true)).toThrow('Unknown permission');
  });

  it('wakes up when a watched task reaches the state, once', async () => {
    const { runner, cos, wfPath, store, toCos } = setup();
    const t = runner.startTask({ workflowPath: wfPath, title: 'x', ref: 'HUB-6' });
    await runner.idle();
    expect(await cos.tool('watch', { task: 'HUB-6', until: 'needs_you', instruction: 'tell me' })).toMatch(/already needs_you/);
    await cos.tool('watch', { task: 'HUB-6', until: 'done', instruction: 'Start the release task.' });
    expect(cos.view().watches).toHaveLength(1);
    runner.decide(store.runsForTask(t.id).find((r) => r.kind === 'human')!.id, 'approved');
    await runner.idle();
    await new Promise((r) => setTimeout(r, 5));
    expect(toCos.filter((m) => m.startsWith('[Orstra] Watch')).length).toBe(1);
    expect(toCos.at(-1)).toMatch(/HUB-6 "x" is now done\. Your instruction was: Start the release task\./);
    expect(cos.view().watches).toHaveLength(0);
    runner.message(t.id, 'still there?', 'chat');
    await new Promise((r) => setTimeout(r, 5));
    expect(toCos.filter((m) => m.startsWith('[Orstra] Watch')).length).toBe(1);
  });

  it('names a task by its title in its cards, in 1 short line, and keeps the instruction as a detail', async () => {
    const { runner, cos, wfPath } = setup();
    const t = runner.startTask({ workflowPath: wfPath, title: 'Rename the menu' });
    await runner.idle();
    await cos.tool('watch', { task: t.id, until: 'done', instruction: 'Start the release task.' });
    const dids = () => cos.view().events.filter((e) => e.kind === 'did') as unknown as { text: string; detail?: string }[];
    expect(dids().at(-1)).toMatchObject({ text: 'Watching “Rename the menu”. I tell you when it is done.', detail: 'Start the release task.' });
    cos.setPermission('start', true);
    await cos.tool('start_task', { workflow: wfPath, title: 'Ship it' });
    expect(dids().at(-1)!.text).toMatch(/^Started “Ship it” · /);
    expect(dids().every((d) => !d.text.includes(t.id.slice(0, 8)))).toBe(true);
  });

  it('keeps one session id for the whole conversation', async () => {
    const { cos, store, cosSessions } = setup();
    cos.say('hello');
    const first = cosSessions[0];
    expect(first.resume).toBe(false);
    expect(store.get('cos.session')).toBe(first.sessionId);
  });

  it('gives it the paths of the files you attached, and keeps your text on the row', async () => {
    const { cos, store, toCos } = setup();
    const file = { name: 'screen.png', path: 'attachments/ab12/screen.png', bytes: 2048, mime: 'image/png' };
    cos.say('what is wrong here?', [file]);
    expect(toCos[0]).toContain('what is wrong here?');
    expect(toCos[0]).toContain('attachments/ab12/screen.png');
    const you = store.events(COS_ID).map((e) => JSON.parse(e.payload)).at(-1);
    expect(you).toMatchObject({ text: 'what is wrong here?', files: [file] });
  });

  it('takes a message that is only a file, and leaves a plain message alone', async () => {
    const { cos, toCos } = setup();
    cos.say('', [{ name: 'run.log', path: 'attachments/cd34/run.log', bytes: 10, mime: 'text/plain' }]);
    expect(toCos[0]).toContain('attachments/cd34/run.log');
    cos.say('and this?');
    expect(toCos[1]).toBe('and this?');
    expect(() => cos.say('')).toThrow('Say something.');
  });
});

describe('cos-mcp', () => {
  it('speaks enough MCP for Claude Code: initialize, list tools, unknown methods', async () => {
    const out: any[] = [];
    setWriter((m) => out.push(m));
    await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    await handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
    await handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    await handle({ jsonrpc: '2.0', id: 3, method: 'nope' });
    await handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'rm_rf', arguments: {} } });
    expect(out[0].result.serverInfo.name).toBe('orstra');
    expect(out[1].result.tools.map((t: any) => t.name)).toEqual(COS_TOOLS.map((t) => t.name));
    expect(out[1].result.tools[0].inputSchema.type).toBe('object');
    expect(out[2].error.code).toBe(-32601);
    expect(out[3].error.message).toBe('Unknown tool rm_rf');
    expect(out).toHaveLength(4);
  });
});
