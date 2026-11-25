import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/db.ts';
import { Runner } from '../src/runner.ts';
import { realExecutors } from '../src/executors.ts';

/** A parent workflow and a child workflow in 1 folder. The child is a human step, so the test decides how each child ends. */
function setup(parentSteps: string) {
  const dir = mkdtempSync(join(tmpdir(), 'orstra-kids-'));
  writeFileSync(join(dir, 'child.yaml'), 'name: Child\nsteps:\n  review:\n    use: human\n    on: { approved: end }\n');
  const wf = join(dir, 'parent.yaml');
  writeFileSync(wf, `name: Parent\nsteps:\n${parentSteps}`);
  const store = new Store(':memory:');
  const runner = new Runner(store, realExecutors, { slots: 2, createWorktree: () => dir });
  return { store, runner, wf, dir };
}

const SPLIT = `  split:\n    use: gate\n    run: ["echo '{\\"data\\": {\\"items\\": [\\"Inbox count\\", \\"Board colors\\", \\"Chat scroll\\"]}}' > \\"$ORSTRA_OUTPUT\\""]\n    next: file\n`;
const FAN_OUT = SPLIT + '  file:\n    use: workflow\n    workflow: child.yaml\n    for_each: steps.split.data.items\n    with: { title: "Fix {{ item }}" }\n    wait: true\n    on: { done: end, partial: end, failed: end }\n';

const kids = (store: Store, parentId: string) => store.tasks().filter((t) => t.parent_task_id === parentId).sort((a, b) => a.created_at - b.created_at || a.title.localeCompare(b.title));
const decideAll = (t: ReturnType<typeof setup>, tasks: { id: string }[]) => {
  for (const k of tasks) t.runner.decide(t.store.runsForTask(k.id)[0].id, 'approved');
};

describe('a workflow step', () => {
  it('starts 1 child and goes on at once when it does not wait', async () => {
    const t = setup('  start:\n    use: workflow\n    workflow: child.yaml\n    next: end\n');
    const parent = t.runner.startTask({ workflowPath: t.wf, title: 'Ship it' });
    await t.runner.idle();
    const children = kids(t.store, parent.id);
    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({ title: 'Ship it', parent_run_id: t.store.runsForTask(parent.id)[0].id, status: 'needs_you' });
    expect(t.store.runsForTask(parent.id)[0].outcome).toBe('started');
    expect(t.store.task(parent.id)!.status).toBe('done');
  });

  it('fans out over a list, waits without going to the Inbox, and ends done when all children are done', async () => {
    const t = setup(FAN_OUT);
    const parent = t.runner.startTask({ workflowPath: t.wf, title: 'Dogfood' });
    await t.runner.idle();
    const children = kids(t.store, parent.id);
    expect(children.map((k) => k.title).sort()).toEqual(['Fix Board colors', 'Fix Chat scroll', 'Fix Inbox count']);
    expect(t.store.task(parent.id)!.status).toBe('running');
    expect(t.store.runsForTask(parent.id).at(-1)).toMatchObject({ status: 'waiting', wait_reason: 'children' });

    decideAll(t, children);
    await t.runner.idle();
    const file = t.store.runsForTask(parent.id).at(-1)!;
    expect(file.outcome).toBe('done');
    expect(JSON.parse(file.data!).children).toHaveLength(3);
    expect(t.store.task(parent.id)!.status).toBe('done');
  });

  it('ends partial when some children were stopped', async () => {
    const t = setup(FAN_OUT);
    const parent = t.runner.startTask({ workflowPath: t.wf, title: 'Dogfood' });
    await t.runner.idle();
    const [a, b, c] = kids(t.store, parent.id);
    t.runner.stop(a.id);
    decideAll(t, [b, c]);
    await t.runner.idle();
    expect(t.store.runsForTask(parent.id).at(-1)!.outcome).toBe('partial');
  });

  it('starts no child twice when a restart runs the step again', async () => {
    const t = setup(FAN_OUT);
    const parent = t.runner.startTask({ workflowPath: t.wf, title: 'Dogfood' });
    await t.runner.idle();
    expect(kids(t.store, parent.id)).toHaveLength(3);
    // The daemon died while the step started its children: the run is still `running`.
    const file = t.store.runsForTask(parent.id).at(-1)!;
    t.store.updateRun(file.id, { status: 'running', wait_reason: null });
    const next = new Runner(t.store, realExecutors, { slots: 2, createWorktree: () => t.dir });
    await next.recover();
    await next.idle();
    expect(kids(t.store, parent.id)).toHaveLength(3);
    expect(t.store.run(file.id)).toMatchObject({ status: 'waiting', wait_reason: 'children' });
  });

  it('says so when for_each names no list', async () => {
    const t = setup('  file:\n    use: workflow\n    workflow: child.yaml\n    for_each: steps.nothing.data.items\n    next: end\n');
    const parent = t.runner.startTask({ workflowPath: t.wf, title: 'x' });
    await t.runner.idle();
    expect(t.store.runsForTask(parent.id)[0].outcome).toBe('cant_do');
    expect(kids(t.store, parent.id)).toHaveLength(0);
  });
});
