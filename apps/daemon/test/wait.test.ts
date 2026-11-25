import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/db.ts';
import { CallbackError, Runner } from '../src/runner.ts';
import type { Executors } from '../src/executors.ts';

const noAgents = { async gate() { return { pass: true, output: '' }; } } as unknown as Executors;

function setup(steps: string, store = new Store(':memory:')) {
  const dir = mkdtempSync(join(tmpdir(), 'orstra-wait-'));
  const wf = join(dir, 'wf.yaml');
  writeFileSync(wf, `name: X\nsteps:\n${steps}`);
  const runner = new Runner(store, noAgents, { slots: 1, createWorktree: () => dir });
  return { store, runner, wf, dir };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const texts = (store: Store, taskId: string) => store.events(taskId).filter((e) => e.kind === 'system').map((e) => JSON.parse(e.payload) as { text: string; url?: string });
const secretOf = (store: Store, taskId: string) => store.runsForTask(taskId).find((r) => r.kind === 'wait')!.callback_secret!;

const TIMER = '  cool:\n    use: wait\n    for: 0.15s\n    next: check\n  check:\n    use: gate\n    run: ["true"]\n    next: end\n';
const CALLBACK = '  ci:\n    use: wait\n    callback: { timeout: 1d }\n    on: { done: route, timeout: end }\n  route:\n    use: switch\n    value: "{{ steps.ci.data.result }}"\n    cases: { green: end, red: fix }\n  fix:\n    use: gate\n    run: ["true"]\n    next: end\n';

describe('a wait step with a timer', () => {
  it('waits without a slot and outside the Inbox, then goes on by itself', async () => {
    const t = setup(TIMER);
    const task = t.runner.startTask({ workflowPath: t.wf, title: 'x' });
    await wait(20);
    const run = t.store.runsForTask(task.id)[0];
    expect(run).toMatchObject({ status: 'waiting', wait_reason: 'timer' });
    expect(t.store.task(task.id)!.status).toBe('running');
    await wait(250);
    await t.runner.idle();
    expect(t.store.task(task.id)!.status).toBe('done');
    expect(t.store.runsForTask(task.id).map((r) => r.outcome)).toEqual(['done', 'pass']);
  });

  it('ends at once when the time it waits until has passed', async () => {
    const t = setup('  w:\n    use: wait\n    until: "2020-01-01T00:00:00Z"\n    next: end\n');
    const task = t.runner.startTask({ workflowPath: t.wf, title: 'x' });
    await wait(60);
    expect(t.store.task(task.id)!.status).toBe('done');
  });

  it('says so when it cannot read the time', async () => {
    const t = setup('  w:\n    use: wait\n    until: "{{ trigger.description }}"\n    next: end\n');
    const task = t.runner.startTask({ workflowPath: t.wf, title: 'x', description: 'next tuesday-ish' });
    await wait(20);
    expect(t.store.runsForTask(task.id)[0].outcome).toBe('cant_do');
    expect(texts(t.store, task.id).map((e) => e.text).join('\n')).toContain('is not a time Orstra can read');
  });

  it('survives a restart, and ends at once when it came due while the daemon was off', async () => {
    const store = new Store(':memory:');
    const t = setup('  w:\n    use: wait\n    for: 1h\n    next: end\n', store);
    const task = t.runner.startTask({ workflowPath: t.wf, title: 'x' });
    await wait(20);
    const run = store.runsForTask(task.id)[0];
    // The daemon is off for longer than the wait. The next one comes up over the same database.
    store.updateRun(run.id, { wake_at: Date.now() - 1000 });
    const next = new Runner(store, noAgents, { slots: 1, createWorktree: () => t.dir });
    await next.recover();
    expect(store.run(run.id)!.outcome).toBe('done');
    expect(store.task(task.id)!.status).toBe('done');
  });
});

describe('a wait step with a callback', () => {
  it('shows a URL, and a call back with data moves the task on the arrow it names', async () => {
    const t = setup(CALLBACK);
    const task = t.runner.startTask({ workflowPath: t.wf, title: 'x' });
    await wait(20);
    const secret = secretOf(t.store, task.id);
    expect(secret).toMatch(/^[0-9a-f]{48}$/);
    expect(texts(t.store, task.id).some((e) => e.url?.endsWith(`/api/callbacks/${secret}`))).toBe(true);
    expect(t.store.task(task.id)!.status).toBe('running');

    t.runner.completeCallback(secret, { outcome: 'done', data: { result: 'red' } });
    await t.runner.idle();
    expect(t.store.runsForTask(task.id).map((r) => [r.step_id, r.outcome])).toEqual([['ci', 'done'], ['route', 'red'], ['fix', 'pass']]);
  });

  it('completes once: a second call and an unknown URL are refused', async () => {
    const t = setup(CALLBACK);
    const task = t.runner.startTask({ workflowPath: t.wf, title: 'x' });
    await wait(20);
    const secret = secretOf(t.store, task.id);
    t.runner.completeCallback(secret, { data: { result: 'green' } });
    expect(() => t.runner.completeCallback(secret, {})).toThrow(CallbackError);
    expect(() => t.runner.completeCallback('0'.repeat(48), {})).toThrow(/No wait has this URL/);
  });

  it('ends with timeout when nothing calls back in time', async () => {
    const t = setup('  ci:\n    use: wait\n    callback: { timeout: 0.1s }\n    on: { done: end, timeout: retry }\n  retry:\n    use: gate\n    run: ["true"]\n    next: end\n');
    const task = t.runner.startTask({ workflowPath: t.wf, title: 'x' });
    await wait(250);
    await t.runner.idle();
    expect(t.store.runsForTask(task.id).map((r) => r.outcome)).toEqual(['timeout', 'pass']);
    expect(texts(t.store, task.id).map((e) => e.text).join('\n')).toContain('Nothing called back before the timeout.');
  });
});

describe('a human step with callback: true', () => {
  const HUMAN = '  review:\n    use: human\n    callback: true\n    on: { approved: ship, changes_requested: end }\n  ship:\n    use: gate\n    run: ["true"]\n    next: end\n';

  it('lets a script decide with 1 of the choices, and keeps its comment as a note', async () => {
    const t = setup(HUMAN);
    const task = t.runner.startTask({ workflowPath: t.wf, title: 'x' });
    await wait(20);
    const run = t.store.runsForTask(task.id)[0];
    expect(t.store.task(task.id)!.status).toBe('needs_you');
    t.runner.completeCallback(run.callback_secret!, { outcome: 'approved', data: { comment: 'CI is green' } });
    await t.runner.idle();
    expect(t.store.runsForTask(task.id).map((r) => [r.step_id, r.outcome])).toEqual([['review', 'approved'], ['ship', 'pass']]);
    const notes = t.store.events(task.id).filter((e) => e.kind === 'note').map((e) => JSON.parse(e.payload).text);
    expect(notes).toContain('CI is green');
  });

  it('refuses a decision that is not 1 of the choices', async () => {
    const t = setup(HUMAN);
    const task = t.runner.startTask({ workflowPath: t.wf, title: 'x' });
    await wait(20);
    const run = t.store.runsForTask(task.id)[0];
    expect(() => t.runner.completeCallback(run.callback_secret!, { outcome: 'merge_it' })).toThrow(/1 of approved, changes_requested/);
    expect(t.store.run(run.id)!.status).toBe('waiting');
  });

  it('still takes your decision in the UI, and then the URL is closed', async () => {
    const t = setup(HUMAN);
    const task = t.runner.startTask({ workflowPath: t.wf, title: 'x' });
    await wait(20);
    const run = t.store.runsForTask(task.id)[0];
    t.runner.decide(run.id, 'changes_requested');
    expect(() => t.runner.completeCallback(run.callback_secret!, { outcome: 'approved' })).toThrow(/over already/);
  });

  it('has no URL when the step does not ask for one', async () => {
    const t = setup('  review:\n    use: human\n    on: { approved: end }\n');
    const task = t.runner.startTask({ workflowPath: t.wf, title: 'x' });
    await wait(20);
    expect(t.store.runsForTask(task.id)[0].callback_secret).toBeNull();
  });
});
