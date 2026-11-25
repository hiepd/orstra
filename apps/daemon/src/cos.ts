import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { withFiles, type Attachment } from './attachments.ts';
import { WATCH_UNTIL, type WatchUntil } from './cos-tools.ts';
import type { Store, TaskRow, WatchRow } from './db.ts';
import type { Executors, LiveSession } from './executors.ts';
import { gitDiff } from './git.ts';
import type { Runner } from './runner.ts';
import type { ScheduleInput, Schedules } from './schedules.ts';
import type { Views } from './server.ts';
import { listWorkflows, resolveWorkflow } from './workflows.ts';
import { pickWorkspace, workspaceView } from './workspace.ts';

/** The events of the chief of staff's conversation are stored like a task's, under this id. */
export const COS_ID = 'cos';

export type Permission = 'msg' | 'start';
/** What the chief of staff may do without asking. Decisions and stopping a task always ask. */
export const DEFAULT_PERMISSIONS: Record<Permission, boolean> = { msg: true, start: false };
const GATE: Record<string, Permission | 'always'> = {
  message_agent: 'msg',
  add_note: 'msg',
  start_task: 'start',
  retry_step: 'start',
  decide: 'always',
  stop_task: 'always',
  // A schedule starts tasks again and again with nobody there, so making or deleting one always asks.
  // Changing one asks like starting a task does.
  create_schedule: 'always',
  update_schedule: 'start',
  delete_schedule: 'always',
};

/** This machine's timezone: what "at 9" means when the user names none. */
const localTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

export interface CosOptions {
  cwd: string;
  /** Claude Code flags for its tools and folders; see cosToolArgs in cos-tools.ts. */
  toolArgs: string[];
  model?: string;
  /** The schedules the daemon fires (Triggers.schedules). Without it, the schedule tools say so. */
  schedules?: Schedules;
}

export interface PlanAction {
  tool: string;
  args: Record<string, any>;
  label: string;
}

const id = (p: string) => `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const label = (t: Pick<TaskRow, 'id' | 'ref'>) => t.ref || t.id.slice(0, 8);
/** How a card names a task for the user: its ticket, else its title. Ids are for the model, not for people. */
const named = (t: Pick<TaskRow, 'ref' | 'title'>) => (t.ref ? `${t.ref} “${t.title}”` : `“${t.title}”`);
const UNTIL_TEXT: Record<string, string> = { needs_you: 'needs you', done: 'is done', stopped: 'is stopped', finished: 'finishes' };
const json = (v: unknown) => JSON.stringify(v, null, 1);

/**
 * The chief of staff: one long-running Claude Code conversation that can see every task and act on them
 * through Orstra's tools. Orstra, not the model, decides which actions need the user's OK.
 */
export class ChiefOfStaff extends EventEmitter {
  private live: LiveSession | null = null;
  private working = false;
  /** The plan that gated actions in the current turn are collected into. */
  private turnPlan: string | null = null;
  /** Things to tell the model with the user's next message (e.g. a plan they declined). */
  private pendingNotes: string[] = [];

  constructor(
    private store: Store,
    private runner: Runner,
    private exec: Executors,
    private views: Views,
    private opts: CosOptions,
  ) {
    super();
  }

  /** Check watches once at startup: tasks may have changed while the daemon was down. */
  start() {
    for (const w of this.store.activeWatches()) this.checkWatches(w.task_id);
  }

  private changed() {
    this.emit('change', { taskId: COS_ID });
  }

  private event(kind: string, payload: unknown) {
    this.store.addEvent(COS_ID, null, kind, payload);
    this.changed();
  }

  permissions(): Record<Permission, boolean> {
    const out = { ...DEFAULT_PERMISSIONS };
    for (const k of Object.keys(out) as Permission[]) {
      const v = this.store.get(`cos.perm.${k}`);
      if (v !== null) out[k] = v === 'true';
    }
    return out;
  }

  setPermission(key: Permission, value: boolean) {
    if (!(key in DEFAULT_PERMISSIONS)) throw new Error(`Unknown permission "${key}".`);
    this.store.set(`cos.perm.${key}`, String(value));
    this.changed();
  }

  /** Everything the chief of staff page shows. */
  view() {
    const plans = this.store.plans().map((p) => ({
      id: p.id,
      status: p.status,
      actions: (JSON.parse(p.actions) as PlanAction[]).map((a) => a.label),
      results: p.results ? (JSON.parse(p.results) as string[]) : null,
    }));
    const watches = this.store.activeWatches().map((w) => {
      const t = this.store.task(w.task_id);
      return { id: w.id, taskId: w.task_id, task: t ? label(t) : w.task_id, title: t?.title ?? '', until: w.until, instruction: w.instruction, createdAt: w.created_at };
    });
    const events = this.store.events(COS_ID).map((e) => ({ id: e.id, ts: e.ts, kind: e.kind, ...JSON.parse(e.payload) }));
    return { working: this.working, events, plans, watches, permissions: this.permissions() };
  }

  // ---------- the conversation ----------

  /** `files` are attachments already written into the chief of staff folder; it reads them by path. */
  say(text: string, files: Attachment[] = []) {
    const t = text.trim();
    if (!t && !files.length) throw new Error('Say something.');
    this.event('you', files.length ? { text: t, files } : { text: t });
    const notes = this.pendingNotes.splice(0);
    const body = withFiles(t, files);
    this.send(notes.length ? `${notes.join('\n')}\n\n${body}` : body);
  }

  interrupt() {
    if (!this.live || !this.working) throw new Error('Your assistant isn’t working on anything.');
    this.live.interrupt();
  }

  private send(text: string) {
    const live = this.ensureSession();
    this.working = true;
    this.changed();
    live.send(text);
  }

  private ensureSession(): LiveSession {
    if (this.live) return this.live;
    let sessionId = this.store.get('cos.session') || '';
    const resume = !!sessionId;
    if (!sessionId) {
      sessionId = randomUUID();
      this.store.set('cos.session', sessionId);
    }
    const live = this.exec.session('claude-code', {
      cwd: this.opts.cwd,
      sessionId,
      resume,
      model: this.opts.model,
      toolArgs: this.opts.toolArgs,
      onEvent: (e) => {
        if (e.kind === 'message') this.event('message', { text: e.text });
        else if (e.kind === 'tool') this.event('tool', { name: e.name.replace(/^mcp__orstra__/, ''), summary: e.summary });
      },
      onTurn: (t) => {
        this.working = false;
        this.turnPlan = null;
        if (t.interrupted) this.event('system', { text: 'Stopped.' });
        else if (t.isError) this.event('system', { text: t.text || 'Your assistant hit an error.' });
        this.changed();
      },
    });
    this.live = live;
    void live.closed.then((res) => {
      if (this.live !== live) return;
      this.live = null;
      this.working = false;
      this.turnPlan = null;
      if (!res.ok) {
        // A session that never got going can't be resumed; start fresh next time.
        if (resume) this.store.set('cos.session', '');
        this.event('system', { text: `Your assistant stopped: ${clip(res.error ?? 'unknown error', 400)}` });
      }
      this.changed();
    });
    return live;
  }

  // ---------- plans (actions waiting for the user's OK) ----------

  async approve(planId: string) {
    const plan = this.store.plan(planId);
    if (!plan || plan.status !== 'pending') throw new Error('That plan isn’t waiting any more.');
    this.store.updatePlan(planId, { status: 'approved', decided_at: Date.now() });
    if (this.turnPlan === planId) this.turnPlan = null;
    const results: string[] = [];
    for (const a of JSON.parse(plan.actions) as PlanAction[]) {
      try {
        const r = await this.execute(a.tool, a.args);
        results.push(r.text);
        this.event('did', { text: r.text, detail: r.detail, taskId: r.taskId ?? null, view: r.view ?? null });
      } catch (err: any) {
        const msg = `Couldn’t ${a.label.charAt(0).toLowerCase() + a.label.slice(1)}: ${err?.message ?? err}`;
        results.push(msg);
        this.event('system', { text: msg });
      }
    }
    this.store.updatePlan(planId, { results: JSON.stringify(results) });
    this.changed();
    this.send(`[Orstra] The user approved plan ${planId}. Results:\n${results.map((r) => `- ${r}`).join('\n')}\nIf you said you'd do something after this (like watching a task), do it now. Then confirm in one short sentence.`);
  }

  decline(planId: string) {
    const plan = this.store.plan(planId);
    if (!plan || plan.status !== 'pending') throw new Error('That plan isn’t waiting any more.');
    this.store.updatePlan(planId, { status: 'declined', decided_at: Date.now() });
    if (this.turnPlan === planId) this.turnPlan = null;
    const labels = (JSON.parse(plan.actions) as PlanAction[]).map((a) => a.label).join('; ');
    this.pendingNotes.push(`[Orstra] The user said "Not now" to plan ${planId} (${labels}). Nothing in it was done. Don't propose it again unless they ask.`);
    this.changed();
  }

  // ---------- watches ----------

  removeWatch(watchId: string) {
    this.store.updateWatch(watchId, { removed_at: Date.now() });
    this.changed();
  }

  private reached(t: TaskRow, until: WatchUntil): boolean {
    if (until === 'done') return t.status === 'done';
    if (until === 'needs_you') return t.status === 'needs_you';
    if (until === 'stopped') return t.status === 'stopped';
    return t.status === 'done' || t.status === 'stopped';
  }

  /**
   * Called on every task change: wake the chief of staff for watches whose condition is now true.
   * Deferred, so whatever caused the change (e.g. an approved plan) finishes and records its result first.
   */
  onTaskChange(taskId: string) {
    setTimeout(() => this.checkWatches(taskId), 0);
  }

  private checkWatches(taskId: string) {
    for (const w of this.store.activeWatches()) {
      if (w.task_id !== taskId) continue;
      const t = this.store.task(taskId);
      if (!t || !this.reached(t, w.until as WatchUntil)) continue;
      this.fire(w, t);
    }
  }

  private fire(w: WatchRow, t: TaskRow) {
    this.store.updateWatch(w.id, { fired_at: Date.now() });
    const state = t.status === 'needs_you' ? `waiting for the user (${t.inbox_reason ?? 'needs you'})` : t.status;
    this.event('did', { text: `${named(t)} ${t.status === 'needs_you' ? 'waits for you' : `is ${t.status}`}. I follow up now.`, detail: w.instruction, taskId: t.id, watch: true });
    this.send(
      `[Orstra] Watch ${w.id} fired: ${label(t)} "${t.title}" is now ${state}. Your instruction was: ${w.instruction}\nDo it now. Your permissions still apply: anything that needs the user's OK becomes a plan. Then tell the user in one or two sentences.`,
    );
  }

  // ---------- tools ----------

  private task(ref: unknown): TaskRow {
    const q = String(ref ?? '').trim();
    if (!q) throw new Error('Which task? Pass its ticket or id.');
    const all = this.store.tasks();
    const hit =
      all.find((t) => t.id === q) ??
      all.find((t) => t.ref && t.ref.toLowerCase() === q.toLowerCase()) ??
      (() => {
        const m = all.filter((t) => t.id.startsWith(q));
        return m.length === 1 ? m[0] : undefined;
      })();
    if (!hit) throw new Error(`No task "${q}". Use list_tasks to see them.`);
    return hit;
  }

  private stepId(t: TaskRow, step: unknown): string {
    const q = String(step ?? '').trim().toLowerCase();
    const wf = this.runner.workflowFor(t);
    const hit = Object.values(wf.steps).find((s) => s.id.toLowerCase() === q || (s.title ?? '').toLowerCase() === q);
    if (!hit) throw new Error(`${label(t)}'s workflow has no step "${step}". Steps: ${Object.values(wf.steps).map((s) => s.title ?? s.id).join(', ')}.`);
    return hit.id;
  }

  private agentName(t: TaskRow): string {
    const runs = this.store.runsForTask(t.id).filter((r) => r.kind === 'agent');
    return runs[runs.length - 1]?.agent === 'codex' ? 'Codex' : 'Claude Code';
  }

  /** A human-readable line for an action, shown on the plan card. */
  private describe(tool: string, a: Record<string, any>): string {
    if (tool === 'start_task') {
      let wf = String(a.workflow);
      try {
        wf = this.runner.workflow(resolveWorkflow(String(a.workflow))).name;
      } catch {
        /* shown as given */
      }
      // Refuses here, before a plan exists, when it cannot tell which workspace: the error names them.
      const ws = this.startWorkspace(a);
      return `Start a task: “${a.title}” · ${wf}${ws ? ` · in ${ws.name}` : ''}`;
    }
    if (tool.endsWith('_schedule')) return this.describeSchedule(tool, a);
    const t = this.task(a.task);
    const stepTitle = (s: unknown) => this.runner.workflowFor(t).steps[this.stepId(t, s)]?.title ?? String(s);
    switch (tool) {
      case 'message_agent':
        return `Message ${this.agentName(t)} on ${label(t)}: “${clip(String(a.text), 300)}”`;
      case 'add_note':
        return `Note for ${stepTitle(a.step)} on ${label(t)}: “${clip(String(a.text), 300)}”`;
      case 'retry_step':
        return `Re-run ${a.step ? stepTitle(a.step) : this.views.stepTitle(t, t.current_step ?? '')} on ${label(t)}${a.note ? ` with the note “${clip(String(a.note), 200)}”` : ''}`;
      case 'decide':
        return `Answer ${label(t)}’s decision: ${String(a.choice).replace(/_/g, ' ')}${a.comment ? `, with “${clip(String(a.comment), 200)}”` : ''}`;
      case 'stop_task':
        return `Stop ${label(t)}`;
      default:
        return tool;
    }
  }

  private get schedules(): Schedules {
    if (!this.opts.schedules) throw new Error('Schedules are not available in this daemon.');
    return this.opts.schedules;
  }

  /** The tool's arguments as a schedule input. A new schedule with no timezone gets this machine's. */
  private scheduleInput(a: Record<string, any>, creating: boolean): ScheduleInput {
    const str = (v: unknown) => (v === undefined || v === null ? undefined : String(v));
    const input: ScheduleInput = { workflow: str(a.workflow), cron: str(a.cron), title: str(a.title), description: str(a.description), workspace: str(a.workspace) };
    if (a.timezone !== undefined) input.timezone = String(a.timezone).toUpperCase() === 'UTC' ? null : String(a.timezone);
    else if (creating) input.timezone = localTimezone();
    if (a.active !== undefined) input.active = a.active === 'on' || a.active === true;
    return input;
  }

  /** The plan-card line for a schedule tool. It checks the input first, so a wrong cron fails before the card. */
  private describeSchedule(tool: string, a: Record<string, any>): string {
    const sid = a.schedule ? String(a.schedule) : undefined;
    if (tool === 'create_schedule') {
      const c = this.schedules.check(this.scheduleInput(a, true));
      return `Create a schedule: “${c.title}” · ${c.workflowName} · ${c.when} (${c.timezone})${c.workspace ? ` · in ${c.workspace}` : ''}`;
    }
    if (!sid) throw new Error('Say which schedule: its id, from list_schedules.');
    const s = this.schedules.editable(sid); // "edit the workflow file" for a declarative one
    if (tool === 'delete_schedule') return `Delete the schedule “${s.title}” · ${s.workflowName} · ${s.when}`;
    const input = this.scheduleInput(a, false);
    const c = this.schedules.check(input, sid);
    const onOff = input.active === undefined ? '' : input.active ? ' · turn it on' : ' · turn it off';
    return `Change the schedule “${s.title}” to: “${c.title}” · ${c.workflowName} · ${c.when} (${c.timezone})${c.workspace ? ` · in ${c.workspace}` : ''}${onOff}`;
  }

  /** The workspace a start_task names, or the only one. A workflow that names its own repo needs none. */
  private startWorkspace(a: Record<string, any>) {
    let wfRepo: string | undefined;
    try {
      wfRepo = this.runner.workflow(resolveWorkflow(String(a.workflow))).repo;
    } catch {
      /* the start itself reports a bad workflow */
    }
    return pickWorkspace(this.store, { workspace: a.workspace ? String(a.workspace) : undefined, repo: wfRepo });
  }

  /** Run an action for real (permission already granted). */
  private async execute(tool: string, a: Record<string, any>): Promise<{ text: string; detail?: string; taskId?: string; view?: string }> {
    if (tool === 'start_task') {
      const path = resolveWorkflow(String(a.workflow));
      const ws = this.startWorkspace(a);
      const t = this.runner.startTask({ workflowPath: path, title: String(a.title), description: a.description ? String(a.description) : undefined, ref: a.ref ? String(a.ref) : undefined, workspaceId: ws?.id, via: 'cos' });
      return { text: `Started ${named(t)} · ${t.workflow_name}`, taskId: t.id };
    }
    if (tool === 'create_schedule') {
      const r = this.schedules.create(this.scheduleInput(a, true));
      const s = r.schedule;
      return { text: `${r.created ? 'Created' : 'Changed'} the schedule “${s.title}” · ${s.workflowName} · ${s.when} (${s.timezone ?? 'UTC'})`, view: 'triggers' };
    }
    if (tool === 'update_schedule') {
      const s = this.schedules.update(String(a.schedule), this.scheduleInput(a, false));
      return { text: `Changed the schedule “${s.title}” · ${s.when} (${s.timezone ?? 'UTC'}) · ${s.active ? 'on' : 'off'}`, view: 'triggers' };
    }
    if (tool === 'delete_schedule') {
      const s = this.schedules.editable(String(a.schedule));
      this.schedules.remove(s.id);
      return { text: `Deleted the schedule “${s.title}” · ${s.workflowName}`, view: 'triggers' };
    }
    const t = this.task(a.task);
    switch (tool) {
      case 'message_agent': {
        await this.runner.message(t.id, String(a.text), 'chat', { via: 'cos' });
        // A message to an agent whose run had ended sends that step back, so say where the task went.
        const after = this.store.task(t.id)!;
        const back = t.status === 'needs_you' && after.status === 'running' ? ` The task went back to ${this.views.stepTitle(after, after.current_step ?? '')}.` : '';
        return { text: `Sent to ${this.agentName(t)} on ${named(t)}.${back}`, detail: clip(String(a.text), 2000), taskId: t.id, view: 'chat' };
      }
      case 'add_note': {
        const stepId = this.stepId(t, a.step);
        await this.runner.message(t.id, String(a.text), 'note', { stepId, via: 'cos' });
        return { text: `Left a note for ${this.views.stepTitle(t, stepId)} on ${named(t)}`, detail: clip(String(a.text), 2000), taskId: t.id };
      }
      case 'retry_step': {
        const stepId = a.step ? this.stepId(t, a.step) : undefined;
        this.runner.retry(t.id, stepId, a.note ? String(a.note) : undefined, 'cos');
        return { text: `Re-running ${this.views.stepTitle(t, stepId ?? t.current_step ?? '')} on ${named(t)}`, detail: a.note ? clip(String(a.note), 2000) : undefined, taskId: t.id };
      }
      case 'decide': {
        const d = this.views.taskDetail(t);
        const human = d.human as null | { runId: string; choices: string[] };
        if (!human) throw new Error(`${label(t)} isn't waiting for a decision.`);
        const choice = String(a.choice);
        if (!human.choices.includes(choice)) throw new Error(`"${choice}" isn't one of the choices: ${human.choices.join(', ')}.`);
        this.runner.decide(human.runId, choice, a.comment ? String(a.comment) : undefined, 'cos');
        return { text: `Answered the decision on ${named(t)}: ${choice.replace(/_/g, ' ')}`, taskId: t.id };
      }
      case 'stop_task':
        this.runner.stop(t.id, 'cos');
        return { text: `Stopped ${named(t)}`, taskId: t.id };
    }
    throw new Error(`Unknown action ${tool}.`);
  }

  /** A tool call from the model. Returns the text the model sees. */
  async tool(name: string, a: Record<string, any> = {}): Promise<string> {
    const gate = GATE[name];
    if (gate) {
      const label = this.describe(name, a); // also validates the task and step
      const allowed = gate !== 'always' && this.permissions()[gate];
      if (allowed) {
        const r = await this.execute(name, a);
        this.event('did', { text: r.text, detail: r.detail, taskId: r.taskId ?? null, view: r.view ?? null });
        return `Done: ${r.text}.`;
      }
      return this.addToPlan(name, a, label);
    }
    return this.read(name, a);
  }

  private addToPlan(tool: string, args: Record<string, any>, actionLabel: string): string {
    let plan = this.turnPlan ? this.store.plan(this.turnPlan) : undefined;
    if (!plan || plan.status !== 'pending') {
      const pid = id('p');
      this.store.insertPlan({ id: pid, status: 'pending', actions: '[]', results: null, created_at: Date.now(), decided_at: null });
      this.turnPlan = pid;
      this.event('plan', { planId: pid });
      plan = this.store.plan(pid)!;
    }
    const actions = JSON.parse(plan.actions) as PlanAction[];
    actions.push({ tool, args, label: actionLabel });
    this.store.updatePlan(plan.id, { actions: JSON.stringify(actions) });
    this.changed();
    return `Needs the user's OK: added "${actionLabel}" to plan ${plan.id}. They see it as a card with "Do it" and "Not now". Don't call this again for the same thing. When you've proposed everything, end your turn with one short sentence. If they approve, you'll get a message with the results.`;
  }

  private read(name: string, a: Record<string, any>): string {
    switch (name) {
      case 'list_tasks':
        return json(
          this.store.tasks().map((t) => {
            const s = this.views.taskSummary(t);
            return { task: label(t), id: t.id, title: t.title, workflow: t.workflow_name, status: t.status, state: s.state, waitingFor: t.status === 'needs_you' ? t.inbox_reason : undefined, step: s.currentStepTitle, attempt: s.run?.attempt, runStatus: s.run?.status, updated: new Date(t.updated_at).toISOString() };
          }),
        );
      case 'get_task': {
        const t = this.task(a.task);
        const d = this.views.taskDetail(t);
        const said = d.events.filter((e: any) => e.kind === 'message').slice(-5).map((e: any) => clip(String(e.text), 1200));
        return json({
          task: label(t), id: t.id, title: t.title, description: t.description, workflow: t.workflow_name, status: t.status, state: d.state, waitingFor: t.inbox_reason, currentStep: d.currentStepTitle,
          steps: d.steps.map((s) => ({ id: s.id, title: s.title, kind: s.kind, on: s.on })),
          path: d.track.map((s) => `${s.title}: ${s.state}`),
          runs: d.runs.map((r) => ({ step: r.stepTitle, attempt: r.attempt, kind: r.kind, agent: r.agent, status: r.status, outcome: r.outcome, progress: r.progress, output: r.output ? clip(r.output.trim().split('\n').slice(-25).join('\n'), 1500) : undefined, started: r.startedAt ? new Date(r.startedAt).toISOString() : undefined, ended: r.endedAt ? new Date(r.endedAt).toISOString() : undefined })),
          decision: d.human,
          agentWaiting: d.awaiting,
          notesForUpcomingSteps: d.notes,
          latestAgentMessages: said,
          worktree: t.worktree,
        });
      }
      case 'get_task_changes': {
        const g = this.views.gitView(this.task(a.task));
        return json({ branch: g.branch, base: g.base, commitsAhead: g.ahead, uncommitted: g.uncommitted, files: g.files, commits: g.commits.map((c) => `${c.sha} ${c.message}`), checks: g.checks.map((c) => ({ name: c.name, state: c.state, detail: clip(c.detail, 800) })) });
      }
      case 'get_diff': {
        const t = this.task(a.task);
        const d = t.worktree ? gitDiff(t.worktree, String(a.path ?? '')) : null;
        if (!d) throw new Error('No diff for that file.');
        return clip(d.diff, 30_000) || '(no changes)';
      }
      case 'read_task_file': {
        const t = this.task(a.task);
        if (!t.worktree) throw new Error(`${label(t)} has no worktree yet.`);
        const file = resolve(t.worktree, String(a.path ?? ''));
        if (!file.startsWith(resolve(t.worktree) + '/') || !existsSync(file) || !statSync(file).isFile()) throw new Error('No such file in the worktree.');
        return clip(readFileSync(file, 'utf8'), 40_000);
      }
      case 'list_workflows':
        return json(
          listWorkflows().map((w) => {
            try {
              const wf = this.runner.workflow(w.path);
              return { file: w.file, name: wf.name, description: wf.description, steps: Object.values(wf.steps).map((s) => `${s.title ?? s.id} (${s.use})`) };
            } catch (err: any) {
              return { file: w.file, name: w.name, error: err?.message };
            }
          }),
        );
      case 'list_watches':
        return json(this.view().watches);
      case 'list_schedules':
        return json(this.schedules.list().map((s) => ({
          id: s.id, kind: s.kind, workflow: s.workflowName, workflowFile: s.kind === 'declarative' ? s.workflowPath : s.workflow,
          cron: s.cron, every: s.everyMinutes ? `${s.everyMinutes} min` : null, when: s.when, timezone: s.timezone ?? (s.cron ? 'UTC' : null),
          title: s.title, workspace: s.workspace?.name ?? null, active: s.active,
          nextRun: s.nextRunAt ? new Date(s.nextRunAt).toISOString() : null,
          lastTask: s.lastTask ? { ref: s.lastTask.ref, title: s.lastTask.title, status: s.lastTask.status, task: s.lastTask.ref ?? s.lastTask.id } : null,
          lastError: s.lastError,
        })));
      case 'list_workspaces':
        return json(this.store.workspaces().map((w) => {
          const v = workspaceView(w);
          return { name: v.name, repo: v.repoPath, baseBranch: v.baseBranch, subdir: v.subdir || null, defaultWorkflow: v.defaultWorkflow };
        }));
      case 'show_tasks': {
        const ids = (Array.isArray(a.tasks) ? a.tasks : []).map((x: unknown) => this.task(x).id);
        if (!ids.length) throw new Error('Pass at least one task.');
        this.event('show', { title: clip(String(a.title ?? ''), 80), taskIds: ids });
        return 'Shown to the user as clickable rows.';
      }
      case 'watch': {
        const t = this.task(a.task);
        const until = String(a.until) as WatchUntil;
        if (!WATCH_UNTIL.includes(until)) throw new Error(`until must be one of: ${WATCH_UNTIL.join(', ')}.`);
        if (this.reached(t, until)) return `${label(t)} is already ${t.status}. Nothing to wait for: act on it now if needed.`;
        const wid = id('w');
        this.store.insertWatch({ id: wid, task_id: t.id, until, instruction: String(a.instruction ?? ''), created_at: Date.now(), fired_at: null, removed_at: null });
        this.event('did', { text: `Watching ${named(t)}. I tell you when it ${UNTIL_TEXT[until] ?? until}.`, detail: String(a.instruction ?? '') || undefined, taskId: t.id, watch: true });
        return `Watching (${wid}). You'll get a message when ${label(t)} is ${until}.`;
      }
      case 'unwatch':
        this.removeWatch(String(a.watch_id));
        return 'Stopped watching.';
    }
    throw new Error(`Unknown tool ${name}.`);
  }
}
