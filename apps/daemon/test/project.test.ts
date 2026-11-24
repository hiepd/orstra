import { describe, expect, it } from 'vitest';
import { Store, type RunRow, type TaskRow } from '../src/db.ts';
import { projectTask, rebuildAll } from '../src/project.ts';

const task = (id: string, p: Partial<TaskRow> = {}): TaskRow => ({
  id, ref: null, title: id, description: '', workflow_path: '/wf.yaml', workflow_name: 'Simple', status: 'running',
  current_step: null, inbox_reason: null, edge_counts: '{}', worktree: null, created_at: 1, updated_at: 1, stopped_at: null, ...p,
});

const run = (id: string, taskId: string, p: Partial<RunRow> = {}): RunRow => ({
  id, task_id: taskId, step_id: 'work', kind: 'agent', attempt: 1, status: 'running', outcome: null, agent: 'claude-code',
  session_id: 's1', progress: null, output: null, created_at: 1, started_at: 1, ended_at: null,
  last_turn_at: null, wait_reason: null, routed: null, ...p,
});

const dead = () => false;
const alive = () => true;

function store(rows: RunRow[], t: Partial<TaskRow> = {}): Store {
  const s = new Store(':memory:');
  s.insertTask(task('t1', t));
  for (const r of rows) s.insertRun(r);
  return s;
}

describe('projectTask', () => {
  it('writes the 3 columns from the runs', () => {
    const s = store([run('r1', 't1', { kind: 'human', step_id: 'review', status: 'waiting', session_id: null })]);
    projectTask(s, dead, 't1');
    expect(s.task('t1')).toMatchObject({ status: 'needs_you', inbox_reason: 'decision', current_step: 'review' });
  });

  it('says running with no reason while the agent works', () => {
    const s = store([run('r1', 't1')]);
    projectTask(s, alive, 't1');
    expect(s.task('t1')).toMatchObject({ status: 'running', inbox_reason: null, current_step: 'work' });
  });

  it('says needs_you with the reason paused when the session is gone', () => {
    const s = store([run('r1', 't1', { status: 'waiting', wait_reason: 'question' })]);
    projectTask(s, dead, 't1');
    expect(s.task('t1')).toMatchObject({ status: 'needs_you', inbox_reason: 'paused' });
    projectTask(s, alive, 't1');
    expect(s.task('t1')).toMatchObject({ status: 'needs_you', inbox_reason: 'question' });
  });

  it('carries the block reason through to the inbox', () => {
    const s = store([run('r1', 't1', { status: 'failed', outcome: 'conflict', routed: 'block:conflict' })]);
    projectTask(s, dead, 't1');
    expect(s.task('t1')).toMatchObject({ status: 'needs_you', inbox_reason: 'conflict', current_step: 'work' });
  });

  it('says done when the last run routed to the end', () => {
    const s = store([run('r1', 't1', { status: 'done', outcome: 'close', routed: 'end' })]);
    projectTask(s, dead, 't1');
    expect(s.task('t1')).toMatchObject({ status: 'done', inbox_reason: null });
  });

  it('keeps a stopped task stopped, whatever its runs say', () => {
    const s = store([run('r1', 't1')], { stopped_at: 5 });
    projectTask(s, alive, 't1');
    expect(s.task('t1')!.status).toBe('stopped');
  });
});

describe('rebuildAll', () => {
  it('reports only the tasks it changed, and touches nothing else', () => {
    const s = store([run('r1', 't1', { kind: 'human', status: 'waiting', session_id: null })]);
    expect(rebuildAll(s, dead)).toEqual([{ taskId: 't1', from: 'running', to: 'needs_you' }]);
    const after = s.task('t1')!.updated_at;
    expect(rebuildAll(s, dead)).toEqual([]);
    expect(s.task('t1')!.updated_at).toBe(after);
  });
});
