import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { checkCron, checkTimezone, describeCron, fillSchedule, nextCron, parseWorkflow, type Trigger, type Workflow } from '@orstra/core';
import type { ScheduleRow, Store, TaskRow } from './db.ts';
import type { Runner } from './runner.ts';
import { listWorkflows } from './workflows.ts';
import { findWorkspace, pickWorkspace } from './workspace.ts';

/**
 * Schedules, the way trigger.dev has them. A schedule points at a workflow and starts 1 task each time
 * its cron matches.
 *
 * - Declarative: a `schedule` trigger in a workflow file. `sync()` copies each one into the database on
 *   every check, so it has a last run and a next run like the others. Only an edit of the file changes it.
 * - Imperative: made in the app or by the chief of staff, and kept only in the database.
 *
 * Firing: 1 loop (`fireDue`, called by Triggers.tick) fires both kinds.
 * - A schedule starts at most 1 task per due time. The task's source is `schedule:<id>@<due ms>`, and
 *   Orstra checks for a task with that source before it starts one. So a crash after the start and
 *   before `next_run_at` moves on starts no second task.
 * - Missed runs: when due times passed while the daemon was off (or the machine slept), the schedule
 *   starts 1 task, for the latest of them, and then waits for the next one. trigger.dev skips them,
 *   but it runs in a cloud that is always on. Orstra runs on a laptop, where a skipped "weekday at 9"
 *   because the lid was shut would lose the day. A schedule you turn on again does not catch up.
 */

export class ScheduleError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export interface ScheduleInput {
  workflow?: string;
  cron?: string;
  /** IANA timezone. Empty or null = UTC. */
  timezone?: string | null;
  title?: string;
  description?: string;
  /** What the agents of each task get, after each step's own prompt. Empty or null = none. */
  prompt?: string | null;
  /** The workspace, by name or id. Needed when there is more than 1 and the workflow names no repo. */
  workspace?: string | null;
  active?: boolean;
  dedupKey?: string;
}

export interface ScheduleView {
  id: string;
  kind: ScheduleRow['kind'];
  workflow: string;
  workflowName: string;
  /** For a declarative schedule: the file to edit. */
  workflowPath: string | null;
  cron: string | null;
  everyMinutes: number | null;
  timezone: string | null;
  /** The timing in words: "At 09:00, Monday through Friday", or "Every 1 day". */
  when: string;
  title: string;
  description: string;
  prompt: string | null;
  workspace: { id: string; name: string } | null;
  active: boolean;
  dedupKey: string | null;
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastTask: { id: string; ref: string | null; title: string; status: TaskRow['status'] } | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

type ScheduleTrigger = Extract<Trigger, { kind: 'schedule' }>;
type WorkflowFile = { path: string; file: string; name?: string };

const id = () => `s-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** "Every 1 day", "Every 6 hours", "Every 30 minutes". */
export function describeEvery(minutes: number): string {
  const [n, unit] = minutes % 1440 === 0 ? [minutes / 1440, 'day'] : minutes % 60 === 0 ? [minutes / 60, 'hour'] : [minutes, 'minute'];
  return `Every ${n} ${unit}${n === 1 ? '' : 's'}`;
}

/** What decides the next run. When it changes, the next run is worked out again. */
const specOf = (r: Pick<ScheduleRow, 'cron' | 'every_minutes' | 'timezone'>) => JSON.stringify([r.cron, r.every_minutes, r.timezone]);

export class Schedules {
  constructor(
    private store: Store,
    private runner: Runner,
    private opts: { now?: () => number; workflows?: () => WorkflowFile[] } = {},
  ) {}

  private now() {
    return (this.opts.now ?? Date.now)();
  }

  private workflows(): WorkflowFile[] {
    return (this.opts.workflows ?? listWorkflows)();
  }

  /** A workflow by file name, file name without .yaml, name, or path. */
  private findWorkflow(ref: string): WorkflowFile & { wf: Workflow } {
    const r = ref.trim();
    let hit = this.workflows().find((w) => w.file === r || w.file.replace(/\.ya?ml$/, '') === r || w.name === r || w.path === r);
    if (!hit && existsSync(r) && statSync(r).isFile()) hit = { path: resolve(r), file: basename(r) };
    if (!hit) throw new ScheduleError(`No workflow called "${ref}". Pick one from the Workflows page.`);
    let wf: Workflow;
    try {
      wf = parseWorkflow(readFileSync(hit.path, 'utf8'));
    } catch (err: any) {
      throw new ScheduleError(`The workflow ${hit.file} does not parse: ${err?.message ?? err}`);
    }
    return { ...hit, name: wf.name, wf };
  }

  /** The next due time after `after`, or null when it never comes. An interval counts from `after`. */
  private nextAfter(r: Pick<ScheduleRow, 'cron' | 'every_minutes' | 'timezone'>, after: number): number | null {
    if (r.cron) return nextCron(r.cron, r.timezone, after);
    if (r.every_minutes) return after + r.every_minutes * 60_000;
    return null;
  }

  // ---- declarative ----

  /**
   * Copy the `schedule` triggers of every workflow file into the database. A changed cron or timezone
   * gets a new next run. A trigger that left its file loses its row. A file that does not parse keeps
   * its rows as they were: the Workflows screen shows the error.
   */
  sync() {
    const now = this.now();
    const seen = new Set<string>();
    const broken = new Set<string>();
    for (const w of this.workflows()) {
      let wf: Workflow;
      try {
        wf = parseWorkflow(readFileSync(w.path, 'utf8'));
      } catch {
        broken.add(w.file);
        continue;
      }
      wf.triggers.forEach((t, i) => {
        if (t.kind !== 'schedule') return;
        const sid = `yaml:${w.file}#${i}`;
        seen.add(sid);
        this.syncOne(sid, w, t, now);
      });
    }
    for (const r of this.store.schedules()) {
      if (r.kind === 'declarative' && !seen.has(r.id) && !broken.has(r.workflow)) this.store.deleteSchedule(r.id);
    }
  }

  private syncOne(sid: string, w: WorkflowFile, t: ScheduleTrigger, now: number) {
    const fields = {
      workflow: w.file, workflow_path: w.path, cron: t.cron ?? null, every_minutes: t.everyMinutes ?? null, timezone: t.timezone ?? null,
      title: t.title, description: t.description ?? '', prompt: t.prompt?.trim() || null, workspace_name: t.workspace ?? null, repo: t.repo ?? null,
    };
    const spec = specOf(fields);
    const old = this.store.schedule(sid);
    if (!old) {
      // Before schedules had rows, an interval kept the time it last fired in kv. Carry it over once.
      const kvKey = `schedule:${w.file}#${i(sid)}`;
      const legacy = Number(this.store.get(kvKey) ?? 0);
      const next = legacy && fields.every_minutes ? legacy + fields.every_minutes * 60_000 : this.nextAfter(fields, now);
      this.store.insertSchedule({
        id: sid, kind: 'declarative', ...fields, workspace_id: null, active: 1, dedup_key: null, spec,
        last_run_at: legacy || null, last_task_id: null, next_run_at: next, last_error: null, created_at: now, updated_at: now,
      });
      if (legacy) this.store.set(kvKey, '0');
      return;
    }
    const changed = (Object.keys(fields) as (keyof typeof fields)[]).some((k) => old[k] !== fields[k]);
    if (old.spec !== spec) this.store.updateSchedule(sid, { ...fields, spec, next_run_at: this.nextAfter(fields, now) });
    else if (changed) this.store.updateSchedule(sid, fields);
  }

  // ---- imperative ----

  /** Throws when the schedule is declarative: only an edit of its workflow file changes it. */
  private imperative(sid: string): ScheduleRow {
    const r = this.store.schedule(sid);
    if (!r) throw new ScheduleError(`There is no schedule with the id ${sid}.`, 404);
    if (r.kind === 'declarative') {
      throw new ScheduleError(`This schedule is declared in the workflow file ${r.workflow_path ?? r.workflow}. Edit the workflow file to change it.`, 409);
    }
    return r;
  }

  /** The workspace for a schedule: the one named, else the only one. Null when there is none or the workflow names its repo. */
  private workspaceFor(ref: string | null | undefined, wf: Workflow): string | null {
    if (ref) {
      const w = findWorkspace(this.store, ref);
      if (!w) throw new ScheduleError(`There is no workspace called ${ref}.`);
      return w.id;
    }
    if (wf.repo || this.store.workspaces().length === 0) return null;
    try {
      return pickWorkspace(this.store, {})?.id ?? null;
    } catch (err: any) {
      throw new ScheduleError(err?.message ?? String(err));
    }
  }

  /** Check an input and turn it into row fields. `base` is the schedule it changes, if any. */
  private fields(input: ScheduleInput, base?: ScheduleRow) {
    const wfRef = input.workflow ?? base?.workflow;
    if (!wfRef?.trim()) throw new ScheduleError('Say which workflow the schedule starts.');
    const w = this.findWorkflow(wfRef);
    const cron = input.cron ?? base?.cron;
    if (!cron?.trim()) throw new ScheduleError('A schedule needs a cron expression, such as "0 9 * * 1-5".');
    const tzIn = input.timezone !== undefined ? input.timezone : base?.timezone;
    const timezone = tzIn?.trim() ? tzIn.trim() : null;
    const title = (input.title ?? base?.title ?? '').trim();
    if (!title) throw new ScheduleError('A schedule needs the title of the task it starts.');
    let cronOk: string;
    try {
      if (timezone) checkTimezone(timezone);
      cronOk = checkCron(cron, timezone);
    } catch (err: any) {
      throw new ScheduleError(err?.message ?? String(err));
    }
    const workspace_id = input.workspace !== undefined ? this.workspaceFor(input.workspace, w.wf) : base ? base.workspace_id : this.workspaceFor(undefined, w.wf);
    const promptIn = input.prompt !== undefined ? input.prompt : base?.prompt;
    return {
      workflow: w.file, cron: cronOk, timezone, title, workspace_id,
      description: (input.description ?? base?.description ?? '').trim(),
      prompt: promptIn?.trim() || null,
    };
  }

  /**
   * Make an imperative schedule. The deduplication key defaults to the workflow, cron, timezone and
   * workspace. When a schedule with that key exists, this changes it instead, as trigger.dev does.
   */
  create(input: ScheduleInput): { schedule: ScheduleView; created: boolean } {
    const f = this.fields(input);
    const dedup_key = input.dedupKey?.trim() || `${f.workflow}|${f.cron}|${f.timezone ?? 'UTC'}|${f.workspace_id ?? ''}`;
    const old = this.store.scheduleByKey(dedup_key);
    if (old) return { schedule: this.update(old.id, input), created: false };
    const now = this.now();
    const active = input.active ?? true;
    const sid = id();
    this.store.insertSchedule({
      id: sid, kind: 'imperative', ...f, workflow_path: null, every_minutes: null, workspace_name: null, repo: null,
      active: active ? 1 : 0, dedup_key, spec: specOf({ ...f, every_minutes: null }),
      last_run_at: null, last_task_id: null, next_run_at: active ? this.nextAfter({ ...f, every_minutes: null }, now) : null,
      last_error: null, created_at: now, updated_at: now,
    });
    return { schedule: this.view(this.store.schedule(sid)!), created: true };
  }

  /** Change an imperative schedule. A new cron or timezone gets a new next run. */
  update(sid: string, input: ScheduleInput): ScheduleView {
    const r = this.imperative(sid);
    const f = this.fields(input, r);
    const patch: Partial<ScheduleRow> = { ...f };
    if (input.dedupKey?.trim() && input.dedupKey.trim() !== r.dedup_key) {
      const other = this.store.scheduleByKey(input.dedupKey.trim());
      if (other && other.id !== sid) throw new ScheduleError(`Another schedule has the deduplication key "${input.dedupKey.trim()}".`, 409);
      patch.dedup_key = input.dedupKey.trim();
    }
    const spec = specOf({ ...f, every_minutes: null });
    const active = input.active ?? !!r.active;
    patch.active = active ? 1 : 0;
    patch.spec = spec;
    if (!active) patch.next_run_at = null;
    else if (spec !== r.spec || !r.active || r.next_run_at === null) patch.next_run_at = this.nextAfter({ ...f, every_minutes: null }, this.now());
    this.store.updateSchedule(sid, patch);
    return this.view(this.store.schedule(sid)!);
  }

  /** Turn an imperative schedule on or off. On again, it waits for its next due time: no catch-up. */
  setActive(sid: string, on: boolean): ScheduleView {
    const r = this.imperative(sid);
    if (!!r.active !== on) this.store.updateSchedule(sid, { active: on ? 1 : 0, next_run_at: on ? this.nextAfter(r, this.now()) : null });
    return this.view(this.store.schedule(sid)!);
  }

  /**
   * Check a create or a change without saving it, and say it in words. The chief of staff calls this
   * before it puts the action on a plan card, so a wrong cron fails at once and not after the OK.
   */
  check(input: ScheduleInput, sid?: string): { workflowName: string; when: string; timezone: string; workspace: string | null; title: string } {
    const base = sid ? this.imperative(sid) : undefined;
    const f = this.fields(input, base);
    const ws = f.workspace_id ? this.store.workspace(f.workspace_id) : undefined;
    return { workflowName: this.findWorkflow(f.workflow).name ?? f.workflow, when: describeCron(f.cron), timezone: f.timezone ?? 'UTC', workspace: ws?.name ?? null, title: f.title };
  }

  /** The imperative schedule with this id, or throws "edit the workflow file" for a declarative one. */
  editable(sid: string): ScheduleView {
    return this.view(this.imperative(sid));
  }

  remove(sid: string) {
    this.imperative(sid);
    this.store.deleteSchedule(sid);
  }

  // ---- read ----

  list(): ScheduleView[] {
    this.sync();
    return this.store.schedules().map((r) => this.view(r));
  }

  get(sid: string): ScheduleView {
    const r = this.store.schedule(sid);
    if (!r) throw new ScheduleError(`There is no schedule with the id ${sid}.`, 404);
    return this.view(r);
  }

  /** The cron in words and its next runs, for a form that has not saved yet. */
  preview(cron: string, timezone?: string | null, count = 3): { cron: string; when: string; next: number[] } {
    let expr: string;
    try {
      expr = checkCron(cron, timezone || null);
    } catch (err: any) {
      throw new ScheduleError(err?.message ?? String(err));
    }
    const next: number[] = [];
    let at = this.now();
    while (next.length < count) {
      const n = nextCron(expr, timezone || null, at);
      if (n === null) break;
      next.push(n);
      at = n;
    }
    return { cron: expr, when: describeCron(expr), next };
  }

  view(r: ScheduleRow): ScheduleView {
    const ws = r.workspace_id ? this.store.workspace(r.workspace_id) : r.workspace_name ? findWorkspace(this.store, r.workspace_name) : undefined;
    const t = r.last_task_id ? this.store.task(r.last_task_id) : undefined;
    const name = this.workflowName(r.workflow);
    return {
      id: r.id, kind: r.kind, workflow: r.workflow, workflowName: name ?? r.workflow, workflowPath: r.kind === 'declarative' ? r.workflow_path : null,
      cron: r.cron, everyMinutes: r.every_minutes, timezone: r.timezone,
      when: r.cron ? describeCron(r.cron) : r.every_minutes ? describeEvery(r.every_minutes) : '',
      title: r.title, description: r.description, prompt: r.prompt,
      workspace: ws ? { id: ws.id, name: ws.name } : r.workspace_name ? { id: '', name: r.workspace_name } : null,
      active: !!r.active, dedupKey: r.dedup_key, nextRunAt: r.next_run_at, lastRunAt: r.last_run_at,
      lastTask: t ? { id: t.id, ref: t.ref, title: t.title, status: t.status } : null,
      lastError: r.last_error, createdAt: r.created_at, updatedAt: r.updated_at,
    };
  }

  /** The `name:` of a workflow file, read the same way as listWorkflows does. */
  private workflowName(file: string): string | undefined {
    const w = this.workflows().find((x) => x.file === file);
    if (!w) return undefined;
    let name = w.name;
    if (!name) {
      try {
        name = readFileSync(w.path, 'utf8').match(/^name:\s*(.+)$/m)?.[1]?.trim();
      } catch {
        return undefined;
      }
    }
    // The line as written: `name: "Orstra: dogfood"` keeps its quotes.
    return name?.replace(/^(["'])(.*)\1$/, '$2');
  }

  // ---- firing ----

  /** Start the task of every active schedule that is due. Returns how many tasks started. */
  fireDue(): number {
    const now = this.now();
    let n = 0;
    for (const r of this.store.schedules()) {
      if (!r.active || r.next_run_at === null || r.next_run_at > now) continue;
      n += this.fire(r, now);
    }
    return n;
  }

  private fire(r: ScheduleRow, now: number): number {
    const due = r.next_run_at!;
    const source = `schedule:${r.id}@${due}`;
    let task = this.store.taskWithSource(source);
    let started = 0;
    let error: string | null = null;
    if (!task) {
      try {
        task = this.start(r, due, source);
        started = 1;
      } catch (err: any) {
        error = err?.message ?? String(err);
      }
    }
    // Move on to the first due time after now: 1 task for all the due times that passed.
    let next: number | null = null;
    try {
      next = this.nextAfter(r, now);
    } catch (err: any) {
      error = err?.message ?? String(err);
    }
    this.store.updateSchedule(r.id, {
      next_run_at: next, last_error: error,
      ...(task ? { last_run_at: due, last_task_id: task.id } : {}),
    });
    return started;
  }

  private start(r: ScheduleRow, due: number, source: string): TaskRow {
    const workflowPath = r.workflow_path && existsSync(r.workflow_path) ? r.workflow_path : this.findWorkflow(r.workflow).path;
    let workspaceId = r.workspace_id ?? undefined;
    if (!workspaceId && r.workspace_name) {
      const w = findWorkspace(this.store, r.workspace_name);
      if (!w) throw new Error(`There is no workspace called ${r.workspace_name}.`);
      workspaceId = w.id;
    }
    const at = { due, timezone: r.timezone, lastRun: r.last_run_at };
    return this.runner.startTask({
      workflowPath, workspaceId, repo: r.repo ?? undefined, source,
      title: fillSchedule(r.title, at), description: fillSchedule(r.description, at) || undefined,
      prompt: r.prompt ? fillSchedule(r.prompt, at) : undefined,
    });
  }
}

/** The trigger index from a declarative id `yaml:<file>#<n>`. */
function i(sid: string): string {
  return sid.slice(sid.lastIndexOf('#') + 1);
}
