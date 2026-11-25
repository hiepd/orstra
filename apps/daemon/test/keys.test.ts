import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/db.ts';
import { Runner } from '../src/runner.ts';
import type { Executors, GateRequest } from '../src/executors.ts';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'orstra-keys-'));
  const a = join(dir, 'a.yaml');
  const b = join(dir, 'b.yaml');
  writeFileSync(a, 'name: A\nsteps:\n  check:\n    use: gate\n    run: ["true"]\n    next: end\n');
  writeFileSync(b, 'name: B\nsteps:\n  check:\n    use: gate\n    run: ["true"]\n    next: end\n');
  const gates: GateRequest[] = [];
  const exec = { async gate(req: GateRequest) { gates.push(req); return { pass: true, output: '' }; } } as unknown as Executors;
  const store = new Store(':memory:');
  const runner = new Runner(store, exec, { slots: 2, createWorktree: () => dir });
  return { store, runner, a, b, gates };
}

describe('an idempotency key on task start', () => {
  it('returns the first task for a second start with the same key, and starts nothing', async () => {
    const t = setup();
    const first = t.runner.startTask({ workflowPath: t.a, title: 'one', idempotencyKey: 'dogfood:t-1:2' });
    const again = t.runner.startTask({ workflowPath: t.a, title: 'two', idempotencyKey: 'dogfood:t-1:2' });
    await t.runner.idle();
    expect(again).toMatchObject({ id: first.id, title: 'one', reused: true });
    expect(t.store.tasks()).toHaveLength(1);
    expect(t.gates).toHaveLength(1);
  });

  it('still holds after the task ended', async () => {
    const t = setup();
    const first = t.runner.startTask({ workflowPath: t.a, title: 'one', idempotencyKey: 'k' });
    await t.runner.idle();
    expect(t.store.task(first.id)!.status).toBe('done');
    expect(t.runner.startTask({ workflowPath: t.a, title: 'x', idempotencyKey: 'k' }).id).toBe(first.id);
  });

  it('is scoped to the workflow, and no key means a new task each time', () => {
    const t = setup();
    const a = t.runner.startTask({ workflowPath: t.a, title: 'x', idempotencyKey: 'k' });
    const b = t.runner.startTask({ workflowPath: t.b, title: 'x', idempotencyKey: 'k' });
    expect(b.id).not.toBe(a.id);
    t.runner.startTask({ workflowPath: t.a, title: 'x' });
    t.runner.startTask({ workflowPath: t.a, title: 'x' });
    expect(t.store.tasks()).toHaveLength(4);
  });
});

describe('the environment of a step', () => {
  it('carries the task id, so an agent can build a key from it', async () => {
    const t = setup();
    const task = t.runner.startTask({ workflowPath: t.a, title: 'x' });
    await t.runner.idle();
    expect(t.gates[0].env).toMatchObject({ ORSTRA_TASK_ID: task.id });
  });
});
