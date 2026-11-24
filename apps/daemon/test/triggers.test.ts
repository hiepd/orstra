import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseWorkflow, parseEvery } from '@orstra/core';
import { Store } from '../src/db.ts';
import { Runner } from '../src/runner.ts';
import type { Executors } from '../src/executors.ts';
import { issueFilter, progressComment, Triggers, type LinearClient } from '../src/triggers.ts';

const HUMAN = `steps:\n  review:\n    use: human\n    question: ok?\n    on: { approved: end }\n`;

function setup(yaml: string, linear?: LinearClient, now = () => Date.now()) {
  const dir = mkdtempSync(join(tmpdir(), 'orstra-trig-'));
  const path = join(dir, 'wf.yaml');
  writeFileSync(path, yaml);
  const store = new Store(':memory:');
  const runner = new Runner(store, {} as Executors, { slots: 1, createWorktree: () => dir });
  const triggers = new Triggers(store, runner, { linear, now, workflows: () => [{ path, file: 'wf.yaml' }] });
  return { store, runner, triggers, path };
}

describe('trigger parsing', () => {
  it('reads linear and schedule triggers', () => {
    const wf = parseWorkflow(`name: X\ntriggers:\n  - linear: { label: agent-ready, team: HUB }\n  - schedule: { every: 1d, title: Triage }\n${HUMAN}`);
    expect(wf.triggers[0]).toEqual({ kind: 'linear', label: 'agent-ready', team: 'HUB', comment: true });
    expect(wf.triggers[1]).toMatchObject({ kind: 'schedule', everyMinutes: 1440, title: 'Triage' });
  });

  it('refuses a trigger it does not know', () => {
    expect(() => parseWorkflow(`name: X\ntriggers:\n  - github: { event: push }\n${HUMAN}`)).toThrow();
  });

  it('reads intervals', () => {
    expect(parseEvery('30m')).toBe(30);
    expect(parseEvery('6h')).toBe(360);
    expect(parseEvery(15)).toBe(15);
    expect(() => parseEvery('soon')).toThrow(/interval/);
  });

  it('asks Linear for open issues with the label by default', () => {
    expect(issueFilter({ kind: 'linear', label: 'agent-ready', comment: true })).toEqual({
      labels: { name: { eqIgnoreCase: 'agent-ready' } },
      state: { type: { nin: ['completed', 'canceled'] } },
    });
  });
});

describe('Triggers', () => {
  it('starts one task per Linear issue, once', async () => {
    const calls: any[] = [];
    const linear: LinearClient = async (q, v) => {
      calls.push({ q, v });
      return { issues: { nodes: [{ id: 'i1', identifier: 'HUB-1', title: 'Empty state', description: 'Show a hint', url: 'https://linear.app/x/HUB-1' }] } };
    };
    const { store, triggers } = setup(`name: X\ntriggers:\n  - linear: { label: agent-ready }\n${HUMAN}`, linear);
    await triggers.tick();
    await triggers.tick();
    const tasks = store.tasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].ref).toBe('HUB-1');
    expect(tasks[0].source).toBe('linear:i1');
    expect(tasks[0].description).toContain('https://linear.app/x/HUB-1');
    expect(triggers.view()[0]).toMatchObject({ started: 1, lastError: null });
  });

  it('says what is missing without an API key', async () => {
    const { store, triggers } = setup(`name: X\ntriggers:\n  - linear: { label: agent-ready }\n${HUMAN}`);
    await triggers.tick();
    expect(store.tasks()).toHaveLength(0);
    expect(triggers.view()[0].lastError).toMatch(/LINEAR_API_KEY/);
  });

  it('starts a scheduled task one interval after it first sees the trigger', async () => {
    let t = 1_000_000;
    const { store, triggers } = setup(`name: X\ntriggers:\n  - schedule: { every: 10m, title: "Triage {{ date }}" }\n${HUMAN}`, undefined, () => t);
    await triggers.tick();
    expect(store.tasks()).toHaveLength(0);
    t += 5 * 60_000;
    await triggers.tick();
    expect(store.tasks()).toHaveLength(0);
    t += 5 * 60_000;
    await triggers.tick();
    expect(store.tasks()).toHaveLength(1);
    expect(store.tasks()[0].title).toMatch(/^Triage \d{4}-\d{2}-\d{2}$/);
  });

  it('posts a progress entry to the Linear issue', async () => {
    const comments: any[] = [];
    const linear: LinearClient = async (q, v) => {
      if (q.includes('commentCreate')) { comments.push(v); return { commentCreate: { success: true } }; }
      return { issues: { nodes: [{ id: 'i9', identifier: 'HUB-9', title: 't', description: null, url: 'u' }] } };
    };
    const { store, triggers } = setup(`name: X\ntriggers:\n  - linear: { label: a }\n${HUMAN}`, linear);
    await triggers.tick();
    const task = store.tasks()[0];
    const run = store.runsForTask(task.id)[0];
    store.updateRun(run.id, { progress: JSON.stringify({ did: 'Added the hint', decided: 'nothing', left: 'Tests' }) });
    await triggers.mirror(task.id, run.id, 'done');
    expect(comments[0].input.issueId).toBe('i9');
    expect(comments[0].input.body).toContain('Did: Added the hint');
    expect(comments[0].input.body).toContain('Left: Tests');
    expect(comments[0].input.body).not.toContain('Decided');
  });

  it('writes a short comment', () => {
    expect(progressComment('Implement', 2, 'done', { did: 'x' })).toBe('**Orstra · Implement (attempt 2)** · done\n\nDid: x');
  });
});
