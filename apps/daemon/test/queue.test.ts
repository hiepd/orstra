import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/db.ts';
import { Runner } from '../src/runner.ts';
import type { Executors, LiveSession } from '../src/executors.ts';

/** Agents that never finish a turn, so every run that starts keeps its slot. */
const busyAgents: Executors = {
  session(): LiveSession {
    return { send() {}, interrupt() {}, end() {}, kill() {}, closed: new Promise(() => {}) };
  },
  async gate() { return { pass: true, output: '' }; },
  async ask() { return ''; },
};

function setup(slots: number, concurrency = 10) {
  const dir = mkdtempSync(join(tmpdir(), 'orstra-queue-'));
  const wf = join(dir, 'wf.yaml');
  writeFileSync(wf, `name: X\nconcurrency: ${concurrency}\nsteps:\n  work:\n    use: agent\n    prompt: go\n    next: end\n`);
  const store = new Store(':memory:');
  const runner = new Runner(store, busyAgents, { slots, createWorktree: () => dir });
  const workspace = (id: string, limit: number | null) => {
    const now = Date.now();
    store.insertWorkspace({ id, name: id, repo_path: dir, base_branch: 'main', subdir: '', default_workflow: null, setup: '[]', copy_files: '[]', env: '{}', concurrency: limit, created_at: now, updated_at: now });
  };
  const status = (taskId: string) => store.runsForTask(taskId)[0].status;
  return { store, runner, wf, workspace, status };
}

const tick = () => new Promise((r) => setTimeout(r, 20));

describe('the limit of a workspace', () => {
  it('holds a run while the workspace has as many working as its limit, though slots are free', async () => {
    const t = setup(5);
    t.workspace('w-hub', 1);
    t.workspace('w-web', null);
    const a = t.runner.startTask({ workflowPath: t.wf, title: 'a', workspaceId: 'w-hub' });
    const b = t.runner.startTask({ workflowPath: t.wf, title: 'b', workspaceId: 'w-hub' });
    const c = t.runner.startTask({ workflowPath: t.wf, title: 'c', workspaceId: 'w-web' });
    await tick();
    expect([t.status(a.id), t.status(b.id), t.status(c.id)]).toEqual(['running', 'queued', 'running']);

    t.runner.stop(a.id);
    await tick();
    expect(t.status(b.id)).toBe('running');
  });
});

describe('priority', () => {
  it('starts the task with more priority first, as if it was queued that many seconds earlier', async () => {
    const t = setup(1);
    const first = t.runner.startTask({ workflowPath: t.wf, title: 'holds the slot' });
    const low = t.runner.startTask({ workflowPath: t.wf, title: 'low' });
    const high = t.runner.startTask({ workflowPath: t.wf, title: 'high', priority: 600 });
    await tick();
    expect([t.status(low.id), t.status(high.id)]).toEqual(['queued', 'queued']);

    t.runner.stop(first.id);
    await tick();
    expect([t.status(low.id), t.status(high.id)]).toEqual(['queued', 'running']);
  });
});
