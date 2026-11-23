import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';

// Loaded via require so bundlers (vitest/vite) don't try to resolve the newer `node:sqlite` builtin.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
type DatabaseSync = DatabaseSyncType;

export type TaskStatus = 'running' | 'needs_you' | 'done' | 'stopped';
export type RunStatus = 'queued' | 'running' | 'waiting' | 'done' | 'failed' | 'stopped';

export interface TaskRow {
  id: string;
  ref: string | null;
  title: string;
  description: string;
  workflow_path: string;
  workflow_name: string;
  status: TaskStatus;
  current_step: string | null;
  inbox_reason: string | null;
  edge_counts: string;
  worktree: string | null;
  created_at: number;
  updated_at: number;
}

export interface RunRow {
  id: string;
  task_id: string;
  step_id: string;
  kind: string;
  attempt: number;
  status: RunStatus;
  outcome: string | null;
  agent: string | null;
  session_id: string | null;
  progress: string | null;
  output: string | null;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
}

export interface EventRow {
  id: number;
  task_id: string;
  run_id: string | null;
  ts: number;
  kind: string;
  payload: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, ref TEXT, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  workflow_path TEXT NOT NULL, workflow_name TEXT NOT NULL, status TEXT NOT NULL,
  current_step TEXT, inbox_reason TEXT, edge_counts TEXT NOT NULL DEFAULT '{}', worktree TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, step_id TEXT NOT NULL, kind TEXT NOT NULL,
  attempt INTEGER NOT NULL, status TEXT NOT NULL, outcome TEXT, agent TEXT, session_id TEXT,
  progress TEXT, output TEXT, created_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER
);
CREATE INDEX IF NOT EXISTS runs_task ON runs(task_id);
CREATE INDEX IF NOT EXISTS runs_status ON runs(status);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, run_id TEXT,
  ts INTEGER NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_task ON events(task_id);
`;

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
  }

  insertTask(t: TaskRow) {
    this.db
      .prepare(
        `INSERT INTO tasks (id, ref, title, description, workflow_path, workflow_name, status, current_step, inbox_reason, edge_counts, worktree, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(t.id, t.ref, t.title, t.description, t.workflow_path, t.workflow_name, t.status, t.current_step, t.inbox_reason, t.edge_counts, t.worktree, t.created_at, t.updated_at);
  }

  updateTask(id: string, patch: Partial<TaskRow>) {
    const fields = { ...patch, updated_at: Date.now() };
    const keys = Object.keys(fields);
    this.db
      .prepare(`UPDATE tasks SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
      .run(...keys.map((k) => (fields as Record<string, unknown>)[k] as never), id);
  }

  task(id: string): TaskRow | undefined {
    return this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
  }

  tasks(): TaskRow[] {
    return this.db.prepare('SELECT * FROM tasks ORDER BY created_at DESC').all() as unknown as TaskRow[];
  }

  insertRun(r: RunRow) {
    this.db
      .prepare(
        `INSERT INTO runs (id, task_id, step_id, kind, attempt, status, outcome, agent, session_id, progress, output, created_at, started_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(r.id, r.task_id, r.step_id, r.kind, r.attempt, r.status, r.outcome, r.agent, r.session_id, r.progress, r.output, r.created_at, r.started_at, r.ended_at);
  }

  updateRun(id: string, patch: Partial<RunRow>) {
    const keys = Object.keys(patch);
    if (!keys.length) return;
    this.db
      .prepare(`UPDATE runs SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
      .run(...keys.map((k) => (patch as Record<string, unknown>)[k] as never), id);
  }

  run(id: string): RunRow | undefined {
    return this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as RunRow | undefined;
  }

  runsForTask(taskId: string): RunRow[] {
    return this.db.prepare('SELECT * FROM runs WHERE task_id = ? ORDER BY created_at, rowid').all(taskId) as unknown as RunRow[];
  }

  runsByStatus(...statuses: RunStatus[]): RunRow[] {
    return this.db
      .prepare(`SELECT * FROM runs WHERE status IN (${statuses.map(() => '?').join(',')}) ORDER BY created_at, rowid`)
      .all(...statuses) as unknown as RunRow[];
  }

  runsSince(ts: number): RunRow[] {
    return this.db.prepare('SELECT * FROM runs WHERE created_at >= ? ORDER BY created_at DESC').all(ts) as unknown as RunRow[];
  }

  addEvent(taskId: string, runId: string | null, kind: string, payload: unknown): EventRow {
    const ts = Date.now();
    const res = this.db
      .prepare('INSERT INTO events (task_id, run_id, ts, kind, payload) VALUES (?, ?, ?, ?, ?)')
      .run(taskId, runId, ts, kind, JSON.stringify(payload));
    return { id: Number(res.lastInsertRowid), task_id: taskId, run_id: runId, ts, kind, payload: JSON.stringify(payload) };
  }

  events(taskId: string): EventRow[] {
    return this.db.prepare('SELECT * FROM events WHERE task_id = ? ORDER BY id').all(taskId) as unknown as EventRow[];
  }
}
