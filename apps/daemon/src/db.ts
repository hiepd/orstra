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
  /** Set when you stopped the task. The 1 stored fact that outranks every run. */
  stopped_at: number | null;
  /** The workflow YAML as it was when the task started. Editing the file does not change a running task. */
  workflow_yaml: string | null;
  /** The pull request a `github.pr` step opened. */
  pr_url: string | null;
  /** Where the task came from, e.g. `linear:<issue id>`. Null for a task you started. */
  source: string | null;
  /** Set when you archive the task; archived tasks leave the lists. */
  archived_at: number | null;
  /** The workspace the task works in. Null for a task started with a bare repo path, or before workspaces existed. */
  workspace_id?: string | null;
  /** The branch the task's branch started from, and that branch's commit at that moment. Fixed at start. */
  base_branch?: string | null;
  base_commit?: string | null;
  /** The folder inside the worktree where agents and gates start. Copied from the workspace at start. */
  subdir?: string | null;
  /** When the workspace's setup commands passed in this task's worktree. */
  setup_at?: number | null;
}

/** Where a task's code is: 1 repo, the branch new tasks start from, and how to prepare a fresh worktree. */
export interface WorkspaceRow {
  id: string;
  name: string;
  repo_path: string;
  base_branch: string;
  /** A folder inside the repo where agents start, or '' for the repo root. */
  subdir: string;
  /** The workflow file the New task form picks first, or null. */
  default_workflow: string | null;
  /** JSON string[]: shell commands run in a new worktree before its first agent or gate step. */
  setup: string;
  /** JSON string[]: gitignored files copied from the repo into each new worktree, such as .env.local. */
  copy_files: string;
  /** JSON Record<string, string>: environment variables for every agent and gate in this workspace. */
  env: string;
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
  /** When an agent's turn last ended on this run. Answers "last turn 27 h ago". */
  last_turn_at: number | null;
  /** Why an open agent run waits on you: question, reply, paused, no_outcome or permission. */
  wait_reason: string | null;
  /** What the router decided when this run ended: `goto:<stepId>`, `end` or `block:<reason>`. */
  routed: string | null;
  /** What the agent's session cost so far, in US dollars (Claude Code's own estimate). */
  cost_usd: number | null;
  /** Tokens the session read (input, cache reads and cache writes) and wrote. */
  tokens_in: number | null;
  tokens_out: number | null;
  /**
   * The agent process this run has open, as a stamp that survives a daemon restart: see process.ts.
   * Set while a session runs, and cleared when it ends. A restart reads it to tell an agent that is
   * still working from one that died with the daemon.
   */
  agent_pid: number | null;
  agent_boot_id: string | null;
  agent_started_at: string | null;
  /**
   * The worktree's commit when this run started, and when it ended. A run Orstra lost track of
   * still leaves a readable range, so you can see what its agent had already committed.
   */
  head_before: string | null;
  head_after: string | null;
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
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, stopped_at INTEGER
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, step_id TEXT NOT NULL, kind TEXT NOT NULL,
  attempt INTEGER NOT NULL, status TEXT NOT NULL, outcome TEXT, agent TEXT, session_id TEXT,
  progress TEXT, output TEXT, created_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER,
  last_turn_at INTEGER, wait_reason TEXT, routed TEXT
);
CREATE INDEX IF NOT EXISTS runs_task ON runs(task_id);
CREATE INDEX IF NOT EXISTS runs_status ON runs(status);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, run_id TEXT,
  ts INTEGER NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_task ON events(task_id);
CREATE INDEX IF NOT EXISTS events_run ON events(run_id);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, repo_path TEXT NOT NULL, base_branch TEXT NOT NULL,
  subdir TEXT NOT NULL DEFAULT '', default_workflow TEXT, setup TEXT NOT NULL DEFAULT '[]',
  copy_files TEXT NOT NULL DEFAULT '[]', env TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY, status TEXT NOT NULL, actions TEXT NOT NULL, results TEXT,
  created_at INTEGER NOT NULL, decided_at INTEGER
);
CREATE TABLE IF NOT EXISTS watches (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, until TEXT NOT NULL, instruction TEXT NOT NULL,
  created_at INTEGER NOT NULL, fired_at INTEGER, removed_at INTEGER
);
`;

/** A batch of actions the chief of staff wants to take that need your OK first. */
export interface PlanRow {
  id: string;
  status: 'pending' | 'approved' | 'declined';
  /** JSON: { tool, args, label }[] */
  actions: string;
  /** JSON: string[], one line per action, once approved */
  results: string | null;
  created_at: number;
  decided_at: number | null;
}

/** "Tell me / do X when task Y reaches a state": wakes the chief of staff. */
export interface WatchRow {
  id: string;
  task_id: string;
  until: string;
  instruction: string;
  created_at: number;
  fired_at: number | null;
  removed_at: number | null;
}

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
    const added = this.migrate();
    if (added.includes('runs.routed')) this.backfill();
    // The index cannot be made over rows that already break it, and a daemon that cannot start helps
    // nobody. Keep the newest open run of each task and close the rest.
    this.closeDuplicateOpenRuns();
    this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS runs_one_open ON runs(task_id) WHERE status IN ('queued','running','waiting');`);
  }

  /** Add the columns that came after the first release. Each one is added once, when it is absent. Returns what it added. */
  private migrate(): string[] {
    const want: Record<string, Record<string, string>> = {
      tasks: { stopped_at: 'INTEGER', workflow_yaml: 'TEXT', pr_url: 'TEXT', source: 'TEXT', archived_at: 'INTEGER',
        workspace_id: 'TEXT', base_branch: 'TEXT', base_commit: 'TEXT', subdir: 'TEXT', setup_at: 'INTEGER' },
      runs: { last_turn_at: 'INTEGER', wait_reason: 'TEXT', routed: 'TEXT', cost_usd: 'REAL', tokens_in: 'INTEGER', tokens_out: 'INTEGER',
        agent_pid: 'INTEGER', agent_boot_id: 'TEXT', agent_started_at: 'TEXT',
        head_before: 'TEXT', head_after: 'TEXT' },
    };
    const added: string[] = [];
    for (const [table, columns] of Object.entries(want)) {
      const have = new Set((this.db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[]).map((c) => c.name));
      for (const [name, type] of Object.entries(columns)) {
        if (have.has(name)) continue;
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
        added.push(`${table}.${name}`);
      }
    }
    return added;
  }

  /**
   * Teach the old rows the facts the new ones write. Without this every finished task would read as
   * "nothing holds this task", because no run of theirs ever recorded what the router decided.
   */
  private backfill() {
    for (const t of this.tasks()) {
      if (t.status === 'stopped') this.db.prepare('UPDATE tasks SET stopped_at = ? WHERE id = ?').run(t.updated_at, t.id);
      if (this.openRun(t.id)) continue;
      const last = this.lastEndedRun(t.id);
      if (!last || last.routed) continue;
      const routed = t.status === 'done' ? 'end' : t.status === 'needs_you' ? `block:${t.inbox_reason ?? 'unknown'}` : null;
      if (routed) this.db.prepare('UPDATE runs SET routed = ? WHERE id = ?').run(routed, last.id);
    }
  }

  private closeDuplicateOpenRuns() {
    const byTask = new Map<string, RunRow[]>();
    for (const r of this.openRuns()) byTask.set(r.task_id, [...(byTask.get(r.task_id) ?? []), r]);
    for (const runs of byTask.values()) {
      for (const r of runs.slice(0, -1)) this.updateRun(r.id, { status: 'stopped', ended_at: Date.now() });
    }
  }

  insertTask(t: TaskRow) {
    this.db
      .prepare(
        `INSERT INTO tasks (id, ref, title, description, workflow_path, workflow_name, status, current_step, inbox_reason, edge_counts, worktree, created_at, updated_at, stopped_at, workflow_yaml, pr_url, source, archived_at, workspace_id, base_branch, base_commit, subdir, setup_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(t.id, t.ref, t.title, t.description, t.workflow_path, t.workflow_name, t.status, t.current_step, t.inbox_reason, t.edge_counts, t.worktree, t.created_at, t.updated_at,
        t.stopped_at ?? null, t.workflow_yaml ?? null, t.pr_url ?? null, t.source ?? null, t.archived_at ?? null,
        t.workspace_id ?? null, t.base_branch ?? null, t.base_commit ?? null, t.subdir ?? null, t.setup_at ?? null);
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

  /** The task a trigger started for this source (e.g. a Linear issue) with this workflow, if any. */
  taskBySource(source: string, workflowPath: string): TaskRow | undefined {
    return this.db.prepare('SELECT * FROM tasks WHERE source = ? AND workflow_path = ? LIMIT 1').get(source, workflowPath) as TaskRow | undefined;
  }

  tasks(): TaskRow[] {
    return this.db.prepare('SELECT * FROM tasks ORDER BY created_at DESC').all() as unknown as TaskRow[];
  }

  insertWorkspace(w: WorkspaceRow) {
    this.db
      .prepare('INSERT INTO workspaces (id, name, repo_path, base_branch, subdir, default_workflow, setup, copy_files, env, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(w.id, w.name, w.repo_path, w.base_branch, w.subdir, w.default_workflow, w.setup, w.copy_files, w.env, w.created_at, w.updated_at);
  }

  updateWorkspace(id: string, patch: Partial<WorkspaceRow>) {
    const fields = { ...patch, updated_at: Date.now() };
    const keys = Object.keys(fields);
    this.db
      .prepare(`UPDATE workspaces SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
      .run(...keys.map((k) => (fields as Record<string, unknown>)[k] as never), id);
  }

  deleteWorkspace(id: string) {
    this.db.prepare('DELETE FROM workspaces WHERE id = ?').run(id);
  }

  workspace(id: string): WorkspaceRow | undefined {
    return this.db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as WorkspaceRow | undefined;
  }

  workspaces(): WorkspaceRow[] {
    return this.db.prepare('SELECT * FROM workspaces ORDER BY name').all() as unknown as WorkspaceRow[];
  }

  insertRun(r: RunRow) {
    this.db
      .prepare(
        `INSERT INTO runs (id, task_id, step_id, kind, attempt, status, outcome, agent, session_id, progress, output, created_at, started_at, ended_at, last_turn_at, wait_reason, routed, cost_usd, tokens_in, tokens_out)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(r.id, r.task_id, r.step_id, r.kind, r.attempt, r.status, r.outcome, r.agent, r.session_id, r.progress, r.output, r.created_at, r.started_at, r.ended_at,
        r.last_turn_at ?? null, r.wait_reason ?? null, r.routed ?? null, r.cost_usd ?? null, r.tokens_in ?? null, r.tokens_out ?? null);
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

  /** Every run that still holds its task. The index keeps this to 1 per task. */
  openRuns(): RunRow[] {
    return this.runsByStatus('queued', 'running', 'waiting');
  }

  openRun(taskId: string): RunRow | undefined {
    return this.db
      .prepare(`SELECT * FROM runs WHERE task_id = ? AND status IN ('queued','running','waiting') ORDER BY created_at, rowid`)
      .get(taskId) as RunRow | undefined;
  }

  /** The newest run that ended with an outcome. A run that was stopped routed nowhere, so it is skipped. */
  lastEndedRun(taskId: string): RunRow | undefined {
    return this.db
      .prepare(`SELECT * FROM runs WHERE task_id = ? AND status IN ('done','failed') AND outcome IS NOT NULL ORDER BY created_at DESC, rowid DESC`)
      .get(taskId) as RunRow | undefined;
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

  get(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? row.value : null;
  }

  set(key: string, value: string) {
    this.db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  insertPlan(p: PlanRow) {
    this.db.prepare('INSERT INTO plans (id, status, actions, results, created_at, decided_at) VALUES (?, ?, ?, ?, ?, ?)').run(p.id, p.status, p.actions, p.results, p.created_at, p.decided_at);
  }

  updatePlan(id: string, patch: Partial<PlanRow>) {
    const keys = Object.keys(patch);
    if (!keys.length) return;
    this.db.prepare(`UPDATE plans SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => (patch as Record<string, unknown>)[k] as never), id);
  }

  plan(id: string): PlanRow | undefined {
    return this.db.prepare('SELECT * FROM plans WHERE id = ?').get(id) as PlanRow | undefined;
  }

  plans(): PlanRow[] {
    return this.db.prepare('SELECT * FROM plans ORDER BY created_at').all() as unknown as PlanRow[];
  }

  insertWatch(w: WatchRow) {
    this.db.prepare('INSERT INTO watches (id, task_id, until, instruction, created_at, fired_at, removed_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(w.id, w.task_id, w.until, w.instruction, w.created_at, w.fired_at, w.removed_at);
  }

  updateWatch(id: string, patch: Partial<WatchRow>) {
    const keys = Object.keys(patch);
    if (!keys.length) return;
    this.db.prepare(`UPDATE watches SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => (patch as Record<string, unknown>)[k] as never), id);
  }

  /** Watches that haven't fired and weren't removed. */
  activeWatches(): WatchRow[] {
    return this.db.prepare('SELECT * FROM watches WHERE fired_at IS NULL AND removed_at IS NULL ORDER BY created_at').all() as unknown as WatchRow[];
  }

  events(taskId: string): EventRow[] {
    return this.db.prepare('SELECT * FROM events WHERE task_id = ? ORDER BY id').all(taskId) as unknown as EventRow[];
  }

  /** A task's events after event `afterId`: what the UI has not seen yet. */
  eventsAfter(taskId: string, afterId: number): EventRow[] {
    return this.db.prepare('SELECT * FROM events WHERE task_id = ? AND id > ? ORDER BY id').all(taskId, afterId) as unknown as EventRow[];
  }

  /** A task's events of these kinds only (notes, decisions), without the long stream of tool calls. */
  eventsOfKind(taskId: string, ...kinds: string[]): EventRow[] {
    return this.db
      .prepare(`SELECT * FROM events WHERE task_id = ? AND kind IN (${kinds.map(() => '?').join(',')}) ORDER BY id`)
      .all(taskId, ...kinds) as unknown as EventRow[];
  }

  /** The latest event of a task of one kind (the last system line, for the Inbox). */
  lastTaskEvent(taskId: string, kind: string): EventRow | undefined {
    return this.db.prepare('SELECT * FROM events WHERE task_id = ? AND kind = ? ORDER BY id DESC LIMIT 1').get(taskId, kind) as EventRow | undefined;
  }

  /** The latest event of a run among these kinds: what its session is doing now. */
  lastRunEvent(runId: string, ...kinds: string[]): EventRow | undefined {
    return this.db
      .prepare(`SELECT * FROM events WHERE run_id = ? AND kind IN (${kinds.map(() => '?').join(',')}) ORDER BY id DESC LIMIT 1`)
      .get(runId, ...kinds) as EventRow | undefined;
  }

  /** The total cost of a task's runs so far. */
  taskCost(taskId: string): { usd: number; tokensIn: number; tokensOut: number } {
    const r = this.db
      .prepare('SELECT COALESCE(SUM(cost_usd), 0) AS usd, COALESCE(SUM(tokens_in), 0) AS tin, COALESCE(SUM(tokens_out), 0) AS tout FROM runs WHERE task_id = ?')
      .get(taskId) as { usd: number; tin: number; tout: number };
    return { usd: r.usd, tokensIn: r.tin, tokensOut: r.tout };
  }

  /** What every run cost since `ts`, for the cost total in Settings. */
  costSince(ts: number): number {
    const r = this.db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS usd FROM runs WHERE created_at >= ?').get(ts) as { usd: number };
    return r.usd;
  }
}
