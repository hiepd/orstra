import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Store, type RunRow, type TaskRow } from '../src/db.ts';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

const file = () => join(mkdtempSync(join(tmpdir(), 'orstra-db-')), 'orstra.db');

const task = (id: string, p: Partial<TaskRow> = {}): TaskRow => ({
  id, ref: null, title: id, description: '', workflow_path: '/wf.yaml', workflow_name: 'Simple', status: 'running',
  current_step: 'work', inbox_reason: null, edge_counts: '{}', worktree: null, created_at: 1, updated_at: 1, stopped_at: null, workflow_yaml: null, pr_url: null, source: null, archived_at: null, ...p,
});

const run = (id: string, taskId: string, p: Partial<RunRow> = {}): RunRow => ({
  id, task_id: taskId, step_id: 'work', kind: 'agent', attempt: 1, status: 'waiting', outcome: null, agent: 'claude-code',
  session_id: null, progress: null, output: null, created_at: 1, started_at: null, ended_at: null,
  last_turn_at: null, wait_reason: null, routed: null, cost_usd: null, tokens_in: null, tokens_out: null, agent_pid: null, agent_boot_id: null, agent_started_at: null, ...p,
});

/** A database file written by the version before this change: no stopped_at, no run facts, no index. */
function oldDatabase(): string {
  const path = file();
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, ref TEXT, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      workflow_path TEXT NOT NULL, workflow_name TEXT NOT NULL, status TEXT NOT NULL,
      current_step TEXT, inbox_reason TEXT, edge_counts TEXT NOT NULL DEFAULT '{}', worktree TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE runs (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, step_id TEXT NOT NULL, kind TEXT NOT NULL,
      attempt INTEGER NOT NULL, status TEXT NOT NULL, outcome TEXT, agent TEXT, session_id TEXT,
      progress TEXT, output TEXT, created_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER
    );
  `);
  const t = (id: string, status: string, step: string | null, reason: string | null) =>
    db.prepare('INSERT INTO tasks (id, ref, title, description, workflow_path, workflow_name, status, current_step, inbox_reason, edge_counts, worktree, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, null, id, '', '/wf.yaml', 'Simple', status, step, reason, '{}', null, 1, 1);
  const r = (id: string, taskId: string, step: string, kind: string, status: string, outcome: string | null, created: number) =>
    db.prepare('INSERT INTO runs (id, task_id, step_id, kind, attempt, status, outcome, agent, session_id, progress, output, created_at, started_at, ended_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, taskId, step, kind, 1, status, outcome, null, null, null, null, created, null, null);

  t('t-done', 'done', null, null);
  r('r-done-1', 't-done', 'work', 'agent', 'done', 'done', 1);
  r('r-done-2', 't-done', 'review', 'human', 'done', 'approved', 2);
  t('t-stuck', 'needs_you', 'merge', 'conflict');
  r('r-stuck-1', 't-stuck', 'merge', 'action', 'failed', 'conflict', 1);
  t('t-open', 'needs_you', 'review', 'decision');
  r('r-open', 't-open', 'review', 'human', 'waiting', null, 1);
  db.close();
  return path;
}

describe('the open run invariant', () => {
  it('refuses a second open run for 1 task', () => {
    const s = new Store(':memory:');
    s.insertTask(task('t1'));
    s.insertRun(run('r1', 't1'));
    expect(() => s.insertRun(run('r2', 't1', { status: 'queued' }))).toThrow();
  });

  it('allows a second run once the first closed', () => {
    const s = new Store(':memory:');
    s.insertTask(task('t1'));
    s.insertRun(run('r1', 't1'));
    s.updateRun('r1', { status: 'done' });
    expect(() => s.insertRun(run('r2', 't1', { status: 'queued' }))).not.toThrow();
  });

  it('allows 1 open run each for 2 tasks', () => {
    const s = new Store(':memory:');
    s.insertTask(task('t1'));
    s.insertTask(task('t2'));
    s.insertRun(run('r1', 't1'));
    expect(() => s.insertRun(run('r2', 't2'))).not.toThrow();
    expect(s.openRuns().map((r) => r.id).sort()).toEqual(['r1', 'r2']);
    expect(s.openRun('t2')!.id).toBe('r2');
  });
});

describe('opening a database written by the old version', () => {
  // Review Focus 1: without the backfill every finished task would read as blocked, reason lost.
  it('adds the new columns and backfills routed from the old task status', () => {
    const s = new Store(oldDatabase());
    expect(s.lastEndedRun('t-done')!.routed).toBe('end');
    expect(s.lastEndedRun('t-stuck')!.routed).toBe('block:conflict');
    expect(s.run('r-open')!.routed).toBe(null);
    expect(s.task('t-done')!.stopped_at).toBe(null);
  });

  it('opens a second time with no error, and backfills nothing twice', () => {
    const path = oldDatabase();
    new Store(path);
    const s = new Store(path);
    expect(s.lastEndedRun('t-done')!.routed).toBe('end');
    expect(s.openRuns()).toHaveLength(1);
  });

  it('closes an older open run that the invariant forbids, so the daemon still starts', () => {
    const path = oldDatabase();
    const db = new DatabaseSync(path);
    db.prepare('INSERT INTO runs (id, task_id, step_id, kind, attempt, status, outcome, agent, session_id, progress, output, created_at, started_at, ended_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run('r-open-2', 't-open', 'work', 'agent', 2, 'running', null, null, null, null, null, 5, null, null);
    db.close();

    const s = new Store(path);
    expect(s.openRuns().map((r) => r.id)).toEqual(['r-open-2']);
    expect(s.run('r-open')!.status).toBe('stopped');
  });
});

describe('lastEndedRun', () => {
  it('takes the newest run that ended with an outcome, and skips one that was stopped', () => {
    const s = new Store(':memory:');
    s.insertTask(task('t1'));
    s.insertRun(run('r1', 't1', { status: 'done', outcome: 'done', created_at: 1 }));
    s.insertRun(run('r2', 't1', { status: 'stopped', outcome: null, created_at: 2 }));
    expect(s.lastEndedRun('t1')!.id).toBe('r1');
  });

  it('is undefined when nothing has ended', () => {
    const s = new Store(':memory:');
    s.insertTask(task('t1'));
    expect(s.lastEndedRun('t1')).toBeUndefined();
  });
});
