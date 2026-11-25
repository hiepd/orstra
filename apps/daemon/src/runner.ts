import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { FINISH_INSTRUCTIONS, formatDuration, parseAgentResult, parseWorkflow, renderTemplate, retryDelay, retryPolicy, route, stripProgressBlock, switchCase, usageReset, type Progress, type Step, type Workflow } from '@orstra/core';
import { excludeFromGit, withFiles, type Attachment } from './attachments.ts';
import { readClaudeLine, summarizeTool, type Executors, type LiveSession, type StreamEvent, type TurnEnd, type TurnUsage } from './executors.ts';
import { entriesAfter, findSessionLog, readSessionLog, whereStopped, type WhereStopped } from './sessionLog.ts';
import type { ArtifactState, RunRow, Store, TaskRow } from './db.ts';
import { ARTIFACT_DIR, DEFAULT_SPEC, collectArtifacts, inputPath, seenKey, stageInputs, type Input } from './artifacts.ts';
import { locateWorkflow } from './workflows.ts';
import { projectTask, rebuildAll } from './project.ts';
import { RERUN_SAFE, runAction } from './actions.ts';
import { cleanupWorktree } from './cleanup.ts';
import { gitCommitsBetween, gitHead } from './git.ts';
import { copyIntoWorktree, taskCwd, workspaceView } from './workspace.ts';
import { isSameProcess, realProcessEnv, stampOf, stopProcess, type ProcessEnv, type ProcessStamp, type StopResult } from './process.ts';

export interface StartTaskInput {
  workflowPath: string;
  title: string;
  description?: string;
  ref?: string;
  /** The workspace to work in, by id. It gives the repo, the base branch and the folder agents start in. */
  workspaceId?: string;
  /** A bare repo path, used once, when the task has no workspace. */
  repo?: string;
  /** The branch to start from. Default: the workspace's base branch. */
  baseBranch?: string;
  /** Who asked: 'cos' when the chief of staff started it. */
  via?: Via;
  /** Where it came from, e.g. `linear:<issue id>` for a task a trigger started. */
  source?: string;
  /** What the trigger tells every agent step, such as a schedule's prompt. */
  prompt?: string;
}

/** chat = talk to the agent's session; note = hand to a step's next run; ask = a forked copy answers. */
export type MessageMode = 'chat' | 'note' | 'ask';

/** Set when the chief of staff acted for you; shown on the task. */
export type Via = 'cos' | undefined;
const byCos = (via: Via) => (via === 'cos' ? ' (by your assistant)' : '');

export interface RunnerOptions {
  slots: number;
  createWorktree: (taskId: string, repo?: string, base?: string) => string;
  /** After an agent finishes a turn with an outcome, wait this long for a follow-up message before closing it. */
  turnGraceMs?: number;
  /** How long a step may work when it sets no `timeout:`. 0 = no limit. */
  defaultTimeoutMs?: { agent?: number; gate?: number };
  /** How long an agent process left by an earlier daemon gets to stop before Orstra kills it. */
  sweepGraceMs?: number;
  /** How this machine identifies a process. A test hands in its own. */
  processEnv?: ProcessEnv;
  /** How to end a stray process. A test hands in its own, so it signals nothing real. */
  stopProcess?: (pid: number, opts?: { graceMs?: number }) => Promise<StopResult>;
  /** Where collected artifacts are kept. Defaults to `~/.orstra/artifacts`. */
  artifactsRoot?: string;
  /** Where Claude Code keeps its session logs. Defaults to $CLAUDE_CONFIG_DIR, else ~/.claude. */
  claudeConfigDir?: string;
}

/** A restart resumes a run on its own at most this many times in RESUME_WINDOW_MS; after that it pauses. */
export const MAX_RESUMES = 3;
export const RESUME_WINDOW_MS = 10 * 60_000;

/** What a restart tells an agent that it resumes. */
export function resumeNote(where: WhereStopped, commits = 0): string {
  const left = commits ? ` You left ${commits} commit${commits === 1 ? '' : 's'} on the branch before the restart.` : '';
  const rest = `${left} Continue the step from where you stopped. Do not repeat the work you finished.`;
  if (where.kind === 'cut') return `Orstra restarted while your tool call ran: ${where.tool} (${where.summary}). The call may not have finished, and its result is lost. Check what it did before you go on.${rest}`;
  return `Orstra restarted while you worked. Your session is intact.${rest}`;
}

/** A failure of the system, not of the work: the retry policy sees it before the outcome arrows do. */
export type Fault = 'crash' | 'error' | 'timeout';

/** The limits when a step sets no `timeout:`: ORSTRA_AGENT_TIMEOUT_MIN (120) and ORSTRA_GATE_TIMEOUT_MIN (30). */
export function defaultTimeoutsFromEnv(): { agent: number; gate: number } {
  const min = (v: string | undefined, d: number) => (v === undefined || v === '' ? d : Number(v)) * 60_000;
  return { agent: min(process.env.ORSTRA_AGENT_TIMEOUT_MIN, 120), gate: min(process.env.ORSTRA_GATE_TIMEOUT_MIN, 30) };
}

/** Claude Code's answer to a permission question: run the tool (maybe with changed input), or not. */
export type PermissionDecision = { behavior: 'allow'; updatedInput: Record<string, unknown> } | { behavior: 'deny'; message: string };

/** A tool call that waits for your OK. */
export interface PendingPermission {
  id: string;
  taskId: string;
  runId: string;
  tool: string;
  input: Record<string, unknown>;
  summary: string;
  ts: number;
  decision?: PermissionDecision;
  waiters: ((d: PermissionDecision) => void)[];
}

/** Sent once when an agent ends a turn with no OUTCOME line, before the task goes to the Inbox. */
export const NUDGE = 'Your last message had no OUTCOME line, so Orstra cannot tell if the step is finished. If you are finished, reply with only the "## Progress" block and the OUTCOME line. If you are not finished, continue the work and end with them.';

interface Live {
  session: LiveSession;
  /** true when this session's outcome moves the task; false for a chat with an already-finished run. */
  routes: boolean;
  humanSpoke: boolean;
  sendSeq: number;
  finished: boolean;
  /** Orstra already asked for the missing OUTCOME line once. */
  nudged: boolean;
  /** The run's cost before this process started; Claude Code counts each process from zero. */
  baseCost: number;
}

const id = (p: string) => `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const SLOT_KINDS = new Set(['agent', 'gate']);
/** What to call a run's agent in a message to the human. */
const agentName = (run: RunRow) => (run.agent === 'codex' ? 'Codex' : 'Claude Code');
/** The event kinds an agent's stream writes. */
const AGENT_KINDS = new Set(['message', 'tool', 'tool_result']);

/** How an agent event is stored, or null when it stores nothing (a message that was only a progress block). */
function storedEvent(e: StreamEvent): { kind: string; payload: unknown } | null {
  if (e.kind !== 'message') return { kind: e.kind, payload: e };
  const text = stripProgressBlock(e.text);
  return text ? { kind: 'message', payload: { kind: 'message', text } } : null;
}

/** A run in one of these still holds its task. The database allows 1 per task. */
const OPEN_STATUSES = new Set(['queued', 'running', 'waiting']);

/**
 * Why a chat to an ended session leaves the task where it is. A closed task reopens through a re-run
 * only, so one message can never restart work you called finished.
 */
function chatOnlyText(task: TaskRow): string {
  if (task.status === 'done') return 'This task is finished, so your message does not move it. Re-run a step to start work again.';
  if (task.status === 'stopped') return 'This task is stopped, so your message does not move it. Re-run a step to start work again.';
  return 'Another step runs right now, so your message does not move the task. The session still answers you.';
}

export class Runner extends EventEmitter {
  private workflows = new Map<string, Workflow>();
  /** Task id -> the parse of the workflow copy the task started with. */
  private snapshots = new Map<string, Workflow>();
  /** Run id -> chat messages that wait for a free slot before they go in. */
  private held = new Map<string, { taskId: string; body: string }[]>();
  private controllers = new Map<string, AbortController>();
  private live = new Map<string, Live>();
  /** Runs whose workspace setup is running: working, with no agent session open yet. */
  private preparing = new Set<string>();
  private timers = 0;
  /** Run id -> the timer that stops it when it works longer than its timeout. */
  private deadlines = new Map<string, NodeJS.Timeout>();
  /** Runs that hit their timeout, so the gate's abort reads as a timeout and not as a stop. */
  private timedOut = new Set<string>();
  /** The 1 timer that calls pump() when the earliest delayed run comes due. */
  private wakeTimer: NodeJS.Timeout | null = null;
  private wakeAt = Infinity;
  /** Permission questions by id, open or answered in the last minute. */
  private permissions = new Map<string, PendingPermission>();
  /**
   * Run id -> the text the agent is writing now, from the stream's chunks. Never stored: the full
   * message replaces it. `after` is the task's newest event when the draft began, so the UI can tell
   * when a stored event has made the draft old.
   */
  private drafts = new Map<string, { taskId: string; text: string; after: number; shown: string }>();

  /** How this machine identifies a process; see process.ts. */
  private get procEnv(): ProcessEnv {
    return this.opts.processEnv ?? realProcessEnv;
  }

  constructor(private store: Store, private exec: Executors, private opts: RunnerOptions) {
    super();
  }

  workflow(path: string): Workflow {
    path = locateWorkflow(path);
    let wf = this.workflows.get(path);
    if (!wf) {
      wf = parseWorkflow(readFileSync(path, 'utf8'));
      this.workflows.set(path, wf);
    }
    return wf;
  }

  /** Drop the cached parse of a workflow file after it was edited, so the next task reads the new version. */
  forgetWorkflow(path: string) {
    this.workflows.delete(path);
  }

  /** The workflow a task follows: the copy it started with, or the file for a task from before copies. */
  workflowFor(task: TaskRow): Workflow {
    if (!task.workflow_yaml) return this.workflow(task.workflow_path);
    let wf = this.snapshots.get(task.id);
    if (!wf) {
      wf = parseWorkflow(task.workflow_yaml);
      this.snapshots.set(task.id, wf);
    }
    return wf;
  }

  /** true when the workflow file changed after the task started, so "use the new version" has an effect. */
  workflowChanged(task: TaskRow): boolean {
    if (!task.workflow_yaml) return false;
    try {
      return readFileSync(locateWorkflow(task.workflow_path), 'utf8') !== task.workflow_yaml;
    } catch {
      return false;
    }
  }

  /**
   * Move a task to the current version of its workflow file. It refuses when the step the task is at
   * is gone from the new version, because the task would then have nowhere to be.
   */
  refreshWorkflow(taskId: string, via?: Via) {
    const task = this.store.task(taskId);
    if (!task) throw new Error('No such task.');
    const yaml = readFileSync(locateWorkflow(task.workflow_path), 'utf8');
    const wf = parseWorkflow(yaml);
    if (task.current_step && !wf.steps[task.current_step]) {
      throw new Error(`The new version has no step "${task.current_step}", where this task is now. Add it back, or retry another step first.`);
    }
    this.store.updateTask(taskId, { workflow_yaml: yaml, workflow_name: wf.name });
    this.snapshots.delete(taskId);
    this.event(taskId, null, 'system', { text: `Now follows the current version of ${wf.name}${byCos(via)}` });
  }

  isLive(runId: string): boolean {
    // A run whose workspace setup is running is working, though no agent session is open yet.
    return this.live.has(runId) || this.preparing.has(runId);
  }

  private changed(taskId: string) {
    this.emit('change', { taskId });
  }

  /** Work the task's state out from its runs and write it down. The only path that writes it. */
  private project(taskId: string) {
    projectTask(this.store, (runId) => this.isLive(runId), taskId);
    this.changed(taskId);
  }

  private event(taskId: string, runId: string | null, kind: string, payload: unknown) {
    this.store.addEvent(taskId, runId, kind, payload);
    this.changed(taskId);
  }

  /**
   * After a restart, continue the work the old daemon left, the way a database replays its WAL.
   *
   * An agent run: stop the old process if it still runs, so its session log stops growing. Replay the
   * log entries after the last one Orstra stored, so the chat shows what the agent did meanwhile.
   * Then look at where it stopped: a turn that ended goes on as it would have; a turn cut in the
   * middle resumes the same session, with a note that names the cut tool call.
   *
   * A gate runs again from the start: its output is its only state. An action runs again when it
   * gives the same result twice (RERUN_SAFE). A step with `rerun: false`, and any other action, stops
   * and asks you.
   */
  async recover(): Promise<void> {
    const work: Promise<void>[] = [];
    for (const r of this.store.runsByStatus('running')) {
      if (r.kind === 'agent' && r.session_id) work.push(this.recoverAgent(r));
      else this.recoverStep(r);
    }
    // A run that waited on a permission question had its agent in the middle of a tool call too.
    for (const r of this.store.runsByStatus('waiting')) {
      if (r.kind === 'agent' && r.session_id && r.wait_reason === 'permission') work.push(this.recoverAgent(r));
    }
    this.rebuild();
    await Promise.all(work);
    this.rebuild();
    this.pump();
  }

  /** A gate or an action that ran when the daemon went: run it again when that is safe, else ask you. */
  private recoverStep(r: RunRow) {
    const again = (text: string) => {
      this.store.updateRun(r.id, { status: 'queued', started_at: null });
      this.store.addEvent(r.task_id, r.id, 'system', { text });
    };
    const ask = (text: string) => {
      this.store.updateRun(r.id, { status: 'failed', outcome: 'interrupted', ended_at: Date.now(), routed: 'block:interrupted' });
      this.store.addEvent(r.task_id, r.id, 'system', { text });
    };
    const task = this.store.task(r.task_id);
    let step: Step | undefined;
    try { step = task ? this.workflowFor(task).steps[r.step_id] : undefined; } catch { step = undefined; }
    const stay = 'Retry it or stop the task.';
    if (step?.rerun === false) {
      return ask(`Orstra restarted while this step ran. The step says rerun: false, so it does not run again on its own. Check what it did, then ${stay.toLowerCase()}`);
    }
    if (r.kind === 'gate') return again('Orstra restarted while this check ran. It runs again from the start.');
    if (r.kind === 'action' && step?.action && (RERUN_SAFE as Record<string, boolean>)[step.action]) {
      return again('Orstra restarted while this action ran. It is safe to run twice, so it runs again.');
    }
    ask(`Orstra restarted while this step was running. ${stay}`);
  }

  /** 1 agent run that was working when the daemon went: replay its log, then continue it. */
  private async recoverAgent(r: RunRow): Promise<void> {
    const stray = this.strayProcess(r);
    if (stray) await this.sweep(r, stray);
    const task = this.store.task(r.task_id);
    if (!task) return;
    const head = task.worktree ? gitHead(task.worktree) : null;
    this.store.updateRun(r.id, { agent_pid: null, agent_boot_id: null, agent_started_at: null, head_after: head });

    // Redo: the entries after the last one Orstra stored. Codex keeps no log Orstra reads.
    let where: WhereStopped = { kind: 'mid' };
    let replayed = 0;
    const file = r.agent === 'codex' ? null : findSessionLog(r.session_id!, this.opts.claudeConfigDir);
    if (file) {
      const entries = readSessionLog(file);
      const from = r.log_uuid ?? this.store.sessionLogUuid(r.session_id!);
      // No position, but events: an Orstra from before the checkpoint stored them. Orstra cannot tell
      // which entries they came from, so it replays none rather than show them twice.
      const legacy = from === null && this.store.events(r.task_id).some((e) => e.run_id === r.id && AGENT_KINDS.has(e.kind));
      for (const e of legacy ? [] : entriesAfter(entries, from)) {
        readClaudeLine(JSON.stringify(e), {
          onEvent: () => {},
          onText: () => {},
          onResult: () => {},
          onLine: (uuid, events) => {
            if (events.length) replayed++;
            this.logLine(r.task_id, r.id, uuid, events);
          },
        });
      }
      where = whereStopped(entries);
    }

    const name = agentName(r);
    const gained = task.worktree ? gitCommitsBetween(task.worktree, r.head_before, head) : null;
    const facts = [
      stray ? `${name} was still working, so Orstra stopped it (pid ${stray.pid}).` : '',
      replayed ? `Orstra read ${replayed} more step${replayed === 1 ? '' : 's'} from the session log.` : '',
      gained ? `It left ${gained} commit${gained === 1 ? '' : 's'} on the branch.` : '',
    ].filter(Boolean).join(' ');
    /** 1 line in the chat: what happened, the facts, then what comes next. */
    const said = (lead: string, next = '') => this.store.addEvent(r.task_id, r.id, 'system', { text: [lead, facts, next].filter(Boolean).join(' ') });

    let recent: number[] = [];
    try { recent = (JSON.parse(r.resumed_at ?? '[]') as number[]).filter((t) => Date.now() - t < RESUME_WINDOW_MS); } catch { recent = []; }
    if (recent.length >= MAX_RESUMES) {
      this.store.updateRun(r.id, { status: 'waiting', wait_reason: 'paused' });
      said(`Orstra restarted mid-run ${recent.length + 1} times in ${RESUME_WINDOW_MS / 60_000} minutes, so it did not resume ${name} again.`, 'Message the session to pick it back up, or retry the step.');
      return;
    }
    if (where.kind === 'ended') {
      said(`Orstra restarted after ${name} ended its turn.`, 'Orstra read the result from the session log.');
      return this.routeRecovered(task, r, where.text, recent);
    }
    if (where.kind === 'cut') said(`Orstra restarted while ${name} ran ${where.tool}: ${where.summary}.`, `${name} continues, and checks that call first.`);
    else said('Orstra restarted mid-run.', `${name} continues where it stopped.`);
    this.resumeAfterRestart(task, r, resumeNote(where, gained ?? 0), recent);
  }

  /** A turn that ended before the restart, read from the log: route it the way onTurn would have. */
  private routeRecovered(task: TaskRow, run: RunRow, text: string, recent: number[]) {
    const parsed = parseAgentResult(text);
    const ends = parsed.hasOutcome && parsed.outcome !== 'needs_you';
    if (!ends && this.overBudget(task.id)) return this.finish(task.id, run.id, 'over_budget');
    if (!parsed.hasOutcome) {
      this.store.addEvent(task.id, run.id, 'system', { text: `${agentName(run)} ended its turn with no OUTCOME line. Orstra asked it to finish the step.` });
      return this.resumeAfterRestart(task, run, NUDGE, recent, { nudged: true });
    }
    if (parsed.outcome === 'needs_you') return this.markWaiting(task.id, run.id, 'question');
    this.store.updateRun(run.id, { progress: JSON.stringify(parsed.progress) });
    this.event(task.id, run.id, 'progress', parsed.progress);
    this.emit('progress', { taskId: task.id, runId: run.id, outcome: parsed.outcome });
    this.finish(task.id, run.id, parsed.outcome);
  }

  /** Open the run's session again and send the note. Unlike your message, it is the step's own work. */
  private resumeAfterRestart(task: TaskRow, run: RunRow, note: string, recent: number[], opts: { nudged?: boolean } = {}) {
    const step = this.workflowFor(task).steps[run.step_id];
    this.store.updateRun(run.id, { status: 'running', wait_reason: null, resumed_at: JSON.stringify([...recent, Date.now()]) });
    const live = this.openSession(task, run, { sessionId: run.session_id!, resume: true, routes: true, model: step?.model });
    if (opts.nudged) live.nudged = true;
    if (step) this.arm(task.id, run.id, step);
    live.session.send(note);
    this.project(task.id);
  }

  /**
   * Stop an agent process this daemon does not own. Two agents on one worktree would edit the same
   * files and append to the same session, so the old one goes before a new one opens.
   */
  private async sweep(run: RunRow, stamp: ProcessStamp) {
    const stop = this.opts.stopProcess ?? stopProcess;
    const how = await stop(stamp.pid, { graceMs: this.opts.sweepGraceMs ?? 5_000 });
    if (how === 'killed') this.event(run.task_id, run.id, 'system', { text: `${agentName(run)} did not stop on its own, so Orstra killed it (pid ${stamp.pid}).` });
  }

  /** Redo the projection for every task, and say which ones moved. */
  rebuild(taskId?: string): { taskId: string; from: string; to: string }[] {
    const isLive = (runId: string) => this.isLive(runId);
    if (taskId) {
      const before = this.store.task(taskId)?.status;
      if (!before) throw new Error('No such task.');
      this.project(taskId);
      const after = this.store.task(taskId)!.status;
      return after === before ? [] : [{ taskId, from: before, to: after }];
    }
    const changed = rebuildAll(this.store, isLive);
    for (const c of changed) this.changed(c.taskId);
    return changed;
  }

  startTask(input: StartTaskInput): TaskRow {
    const yaml = readFileSync(locateWorkflow(input.workflowPath), 'utf8');
    const wf = parseWorkflow(yaml);
    const taskId = id('t');
    const ws = input.workspaceId ? this.store.workspace(input.workspaceId) : undefined;
    if (input.workspaceId && !ws) throw new Error(`There is no workspace with id ${input.workspaceId}.`);
    const repo = ws ? ws.repo_path : input.repo ?? wf.repo;
    const base = repo ? input.baseBranch?.trim() || ws?.base_branch || undefined : undefined;
    const worktree = this.opts.createWorktree(taskId, repo, base);
    const now = Date.now();
    const task: TaskRow = {
      id: taskId, ref: input.ref ?? null, title: input.title, description: input.description ?? '',
      workflow_path: input.workflowPath, workflow_name: wf.name, status: 'running', current_step: wf.start,
      inbox_reason: null, edge_counts: '{}', worktree, created_at: now, updated_at: now, stopped_at: null,
      workflow_yaml: yaml, pr_url: null, source: input.source ?? null, archived_at: null,
      workspace_id: ws?.id ?? null, base_branch: base ?? null, base_commit: repo ? gitHead(worktree) : null, subdir: ws?.subdir || null, setup_at: null,
      prompt: input.prompt?.trim() || null,
    };
    this.store.insertTask(task);
    this.event(taskId, null, 'system', { text: `Started ${wf.name}${ws ? ` in ${ws.name}` : ''}${byCos(input.via)}` });
    if (ws) {
      const files = workspaceView(ws).copyFiles;
      if (files.length) {
        const { copied, missing } = copyIntoWorktree(ws.repo_path, worktree, files);
        const said = [copied.length ? `Copied ${copied.join(', ')} into the worktree.` : '', missing.length ? `The repo has no ${missing.join(', ')}, so it was not copied.` : ''];
        this.event(taskId, null, 'system', { text: said.filter(Boolean).join(' ') });
      }
    }
    this.queueStep(task, wf.start);
    this.pump();
    return task;
  }

  private queueStep(task: TaskRow, stepId: string) {
    const step = this.workflowFor(task).steps[stepId];
    const attempt = this.store.runsForTask(task.id).filter((r) => r.step_id === stepId).length + 1;
    const run: RunRow = {
      id: id('r'), task_id: task.id, step_id: stepId, kind: step.use, attempt, status: 'queued', outcome: null,
      agent: step.use === 'agent' ? step.agent ?? 'claude-code' : null, session_id: null, progress: null, output: null,
      created_at: Date.now(), started_at: null, ended_at: null, last_turn_at: null, wait_reason: null, routed: null,
      cost_usd: null, tokens_in: null, tokens_out: null, agent_pid: null, agent_boot_id: null, agent_started_at: null, head_before: null, head_after: null, log_uuid: null, resumed_at: null,
    };
    this.store.insertRun(run);
    this.project(task.id);
  }

  /** Agent and gate runs that work now: each one takes a slot. */
  private busySlots(): RunRow[] {
    return this.store.runsByStatus('running').filter((r) => SLOT_KINDS.has(r.kind));
  }

  /**
   * Start queued runs while there are free slots. Human, switch and action steps don't take a slot.
   * Chat messages that wait for a slot go first: you sent them before the queued runs could start.
   * A workflow's `concurrency` caps how many of its tasks work at the same time.
   */
  pump() {
    const running = this.busySlots();
    let busy = running.length;
    for (const [runId, msgs] of [...this.held]) {
      if (busy >= this.opts.slots) break;
      const run = this.store.run(runId);
      const task = run && this.store.task(run.task_id);
      this.held.delete(runId);
      if (!run || !task || task.status === 'stopped' || run.status !== 'waiting') continue;
      busy++;
      for (const m of msgs) this.deliver(task, run, m.body);
    }
    const perWorkflow = new Map<string, number>();
    for (const r of running) {
      const t = this.store.task(r.task_id);
      if (t) perWorkflow.set(t.workflow_path, (perWorkflow.get(t.workflow_path) ?? 0) + 1);
    }
    const now = Date.now();
    let nextDue = Infinity;
    for (const run of this.store.runsByStatus('queued')) {
      const task = this.store.task(run.task_id);
      if (!task || task.stopped_at) continue;
      // A retry waits out its delay. The timer below calls pump() again when the first one is due.
      if (run.not_before && run.not_before > now) {
        nextDue = Math.min(nextDue, run.not_before);
        continue;
      }
      if (SLOT_KINDS.has(run.kind)) {
        if (busy >= this.opts.slots) continue;
        let cap = Infinity;
        try { cap = this.workflowFor(task).concurrency; } catch { /* a broken workflow fails in execute() */ }
        const n = perWorkflow.get(task.workflow_path) ?? 0;
        if (n >= cap) continue;
        perWorkflow.set(task.workflow_path, n + 1);
        busy++;
      }
      this.store.updateRun(run.id, { status: 'running', started_at: Date.now() });
      this.execute(task, { ...run, status: 'running' }).catch((err) => {
        // The handler for a crash must not crash: an unhandled rejection here ends the daemon.
        try {
          this.fault(task.id, run.id, 'crash', `Run crashed: ${err?.message ?? err}`);
        } catch (inner: any) {
          console.error(`[orstra] could not record the crash of run ${run.id} on task ${task.id}:`, inner?.message ?? inner);
        }
      });
    }
    this.wakeFor(nextDue);
  }

  /** Call pump() at `at`, unless a timer for an earlier time is set already. */
  private wakeFor(at: number) {
    if (at === Infinity || at >= this.wakeAt) return;
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeAt = at;
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = null;
      this.wakeAt = Infinity;
      this.pump();
    }, Math.max(0, at - Date.now()) + 5);
    this.wakeTimer.unref?.();
  }

  /**
   * A run failed for a reason outside the work: its process crashed, the API gave an error, or
   * (when the step says so) it timed out. Retry it after a delay while the step's retry policy
   * allows. After that the fault goes to the router as `cant_do` or `timeout`, as it always did.
   *
   * A retry is a new run of the same step. An agent's retry resumes the same session, so the work
   * of the try before stays.
   */
  private fault(taskId: string, runId: string, kind: Fault, text: string, notBefore?: number | null) {
    const run = this.store.run(runId);
    const task = this.store.task(taskId);
    const final = kind === 'timeout' ? 'timeout' : 'cant_do';
    if (!run || !task || task.stopped_at || !OPEN_STATUSES.has(run.status)) return this.finish(taskId, runId, final);
    let step: Step | undefined;
    try { step = this.workflowFor(task).steps[run.step_id]; } catch { step = undefined; }
    const policy = step ? retryPolicy(step) : undefined;
    const n = (run.retries ?? 0) + 1;
    if (!step || !policy || n > policy.max || (kind === 'timeout' && !policy.onTimeout)) {
      // onTimeout() already said that the step timed out.
      if (kind !== 'timeout') this.event(taskId, runId, 'system', { text });
      return this.finish(taskId, runId, final);
    }
    this.disarm(runId);
    this.timedOut.delete(runId);
    this.collect(task, run, step);
    const now = Date.now();
    const at = notBefore && notBefore > now ? notBefore : now + retryDelay(policy, n);
    this.store.updateRun(runId, { status: 'failed', outcome: kind === 'timeout' ? 'timeout' : 'crashed', ended_at: now, routed: 'retry', output: text });
    const attempt = this.store.runsForTask(taskId).filter((r) => r.step_id === run.step_id).length + 1;
    this.store.insertRun({
      id: id('r'), task_id: taskId, step_id: run.step_id, kind: run.kind, attempt, status: 'queued', outcome: null,
      agent: run.agent, session_id: run.session_id, progress: null, output: null, created_at: now, started_at: null, ended_at: null,
      last_turn_at: null, wait_reason: null, routed: null, cost_usd: null, tokens_in: null, tokens_out: null, agent_pid: null, agent_boot_id: null,
      agent_started_at: null, head_before: null, head_after: null, log_uuid: null, resumed_at: null, not_before: at, retries: n,
    });
    const why = notBefore && notBefore > now ? 'when the usage limit lifts' : `in ${formatDuration(at - now)}`;
    this.event(taskId, runId, 'system', { text: `${text} Orstra retries this step ${why} (retry ${n} of ${policy.max}).` });
    this.project(taskId);
    this.pump();
  }

  /** What a resumed session is told when its run is a retry after a fault. */
  private retryNote(task: TaskRow, run: RunRow): string {
    const before = this.store.runsForTask(task.id).filter((r) => r.step_id === run.step_id && r.routed === 'retry' && r.id !== run.id).pop();
    const step = this.workflowFor(task).steps[run.step_id];
    const max = step ? retryPolicy(step).max : run.retries ?? 1;
    return [
      '--- Orstra ---',
      `Your last try of this step ended with a fault, not with an outcome: ${before?.output ?? 'the process stopped'}. This is retry ${run.retries} of ${max}. Check what the last try left (git status, the files you changed), then continue the step from where it stopped. Do not repeat the work you finished.`,
      FINISH_INSTRUCTIONS.trim(),
    ].join('\n\n');
  }

  /** Resolves when nothing is running or queued and no turn is about to close (used by tests and the CLI). */
  async idle() {
    for (;;) {
      if (!this.store.runsByStatus('running', 'queued').length && this.timers === 0) return;
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  private context(task: TaskRow) {
    const steps: Record<string, unknown> = {};
    for (const r of this.store.runsForTask(task.id)) {
      if (r.progress) {
        const p = JSON.parse(r.progress) as Progress;
        steps[r.step_id] = { output: p.did, progress: p, outcome: r.outcome };
      }
    }
    // {{ steps.<id>.artifacts }}: where that step's kept files are for the run that reads the template.
    for (const i of this.inputs(task.id)) {
      const s = (steps[i.stepId] ??= {}) as { artifacts?: string[] };
      (s.artifacts ??= []).push(inputPath(i.stepId, i.name));
    }
    const trigger = { title: task.title, description: task.description, ref: task.ref, id: task.ref ?? task.id, prompt: task.prompt ?? '' };
    return { trigger, task: { id: task.id, ref: task.ref, title: task.title }, steps };
  }

  /** The task's progress entries, as the next fresh session should see them. */
  private progressText(task: TaskRow, wf: Workflow): string {
    const lines: string[] = [];
    for (const r of this.store.runsForTask(task.id)) {
      if (!r.outcome || (!r.progress && !r.output)) continue;
      const name = wf.steps[r.step_id]?.title ?? r.step_id;
      if (r.progress) {
        const p = JSON.parse(r.progress) as Progress;
        const parts = [`Did: ${p.did}`, p.decided && `Decided: ${p.decided}`, p.left && `Left: ${p.left}`, p.avoid && `Avoid: ${p.avoid}`].filter(Boolean);
        lines.push(`- ${name} (attempt ${r.attempt}, ${r.outcome}): ${parts.join(' | ')}`);
      } else if (r.output) {
        lines.push(`- ${name} (attempt ${r.attempt}, ${r.outcome}). Output:\n${r.output.split('\n').slice(-30).join('\n')}`);
      }
    }
    return lines.length ? lines.join('\n') : '(none yet; you are the first step)';
  }

  /** Notes for this step written since its previous run started (human notes, decision comments). */
  private notesFor(task: TaskRow, step: Step, run: RunRow): string[] {
    const prev = this.store.runsForTask(task.id).filter((r) => r.step_id === step.id && r.id !== run.id).pop();
    const since = prev?.created_at ?? 0;
    return this.store
      .events(task.id)
      .filter((e) => e.kind === 'note' && e.ts >= since)
      .map((e) => JSON.parse(e.payload) as { step?: string; text: string })
      .filter((n) => !n.step || n.step === step.id)
      .map((n) => n.text);
  }

  /**
   * What the earlier steps kept, newest attempt of each step: the stored copies a run gets as inputs.
   * The step that runs now sees its own earlier attempts too, so a retry can build on them.
   */
  private inputs(taskId: string, runId?: string): (Input & { stepTitle: string; attempt: number; bytes: number })[] {
    const runs = new Map(this.store.runsForTask(taskId).map((r) => [r.id, r]));
    const newest = new Map<string, string>(); // step -> run with the newest kept files
    for (const a of this.store.artifactsForTask(taskId)) {
      if (a.state !== 'saved' || !a.path || a.run_id === runId) continue;
      newest.set(a.step_id, a.run_id);
    }
    const task = this.store.task(taskId);
    const wf = task ? this.workflowFor(task) : undefined;
    return this.store
      .artifactsForTask(taskId)
      .filter((a) => a.state === 'saved' && a.path && newest.get(a.step_id) === a.run_id)
      .map((a) => ({ stepId: a.step_id, name: a.name, from: a.path!, bytes: a.bytes, attempt: runs.get(a.run_id)?.attempt ?? 1, stepTitle: wf?.steps[a.step_id]?.title ?? a.step_id }));
  }

  /** Before an agent or gate run: keep .orstra/ out of git and put the earlier steps' artifacts in place. */
  private stage(task: TaskRow, run: RunRow): string {
    if (!task.worktree) return '';
    excludeFromGit(task.worktree);
    const inputs = this.inputs(task.id, run.id);
    const placed = new Set(stageInputs(task.worktree, inputs));
    const lines = inputs
      .filter((i) => placed.has(inputPath(i.stepId, i.name)))
      .map((i) => `- ${inputPath(i.stepId, i.name)} (${i.stepTitle}${i.attempt > 1 ? `, attempt ${i.attempt}` : ''}, ${Math.max(1, Math.round(i.bytes / 1024))} KB)`);
    return lines.length ? `Artifacts the earlier steps kept (read the ones you need):\n${lines.join('\n')}` : '';
  }

  /** Where to keep files, and what this step must leave, so a fresh session knows the paths. */
  private artifactText(step: Step): string {
    const keep = `To keep a file for the steps after you and for the human's review (a plan, a report, test output, a log), write it under ${ARTIFACT_DIR}/. Orstra copies everything new there when you finish.`;
    if (!step.artifacts?.length) return keep;
    const lines = step.artifacts.map((a) => `- ${a.path}`).join('\n');
    return `${keep}\nOrstra also keeps these files when this step writes them:\n${lines}`;
  }

  private buildPrompt(task: TaskRow, wf: Workflow, step: Step, run: RunRow, inputs = ''): string {
    const notes = this.notesFor(task, step, run);
    return [
      renderTemplate(step.prompt ?? '', this.context(task)),
      '---',
      `Task: ${task.ref ? task.ref + ' ' : ''}${task.title}`,
      task.description && `Description:\n${task.description}`,
      // The trigger's own instructions. The workflow does not name them: every agent step gets them here.
      task.prompt && `Prompt:\n${task.prompt}`,
      this.artifactText(step),
      inputs,
      `Progress so far (each earlier step ran in its own session):\n${this.progressText(task, wf)}`,
      notes.length ? `Notes from the human for this step:\n${notes.map((n) => `- ${n}`).join('\n')}` : '',
      run.attempt > 1 ? `This is attempt ${run.attempt} of this step. Read the progress above and do not repeat what failed.` : '',
      'The human may message you while you work. Read their messages and follow them.',
      FINISH_INSTRUCTIONS,
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  private openSession(task: TaskRow, run: RunRow, opts: { sessionId: string; resume: boolean; routes: boolean; model?: string }): Live {
    const onEvent = (e: StreamEvent) => {
      const row = storedEvent(e);
      if (row) this.event(task.id, run.id, row.kind, row.payload);
    };
    const live: Live = { session: null as unknown as LiveSession, routes: opts.routes, humanSpoke: false, sendSeq: 0, finished: false, nudged: false, baseCost: this.store.run(run.id)?.cost_usd ?? 0 };
    live.session = this.exec.session((run.agent as 'claude-code' | 'codex') ?? 'claude-code', {
      cwd: taskCwd(task), env: this.envOf(task), sessionId: opts.sessionId, resume: opts.resume, model: opts.model, runId: run.id,
      onSessionId: (sid) => {
        if (this.store.run(run.id)?.session_id !== sid) this.store.updateRun(run.id, { session_id: sid });
      },
      onEvent,
      onLog: (uuid, events) => this.logLine(task.id, run.id, uuid, events),
      onDelta: (text) => this.addDraft(task.id, run.id, text),
      onTurn: (t) => this.onTurn(task.id, run.id, t),
    });
    this.live.set(run.id, live);
    this.stamp(run.id, live.session.pid);
    this.changed(task.id);
    void live.session.closed.then((res) => this.onClosed(task.id, run.id, live, res));
    return live;
  }

  /**
   * 1 line of the agent's session log: its events and its position, in 1 transaction. A crash then
   * leaves either both or neither, so the replay after it shows each event once.
   */
  private logLine(taskId: string, runId: string, uuid: string, events: StreamEvent[]) {
    this.store.tx(() => {
      for (const e of events) {
        const row = storedEvent(e);
        if (row) this.store.addEvent(taskId, runId, row.kind, row.payload);
      }
      this.store.updateRun(runId, { log_uuid: uuid });
    });
    if (!events.length) return;
    this.endDraft(runId);
    this.changed(taskId);
  }

  /** A chunk of the text the agent writes now. The UI gets the whole draft each time, never a part. */
  private addDraft(taskId: string, runId: string, chunk: string) {
    let d = this.drafts.get(runId);
    if (!d) {
      d = { taskId, text: '', after: this.store.lastEventId(taskId), shown: '' };
      this.drafts.set(runId, d);
    }
    d.text += chunk;
    // The progress block and the OUTCOME line never show, so a chunk inside them changes nothing.
    const text = stripProgressBlock(d.text);
    if (!text || text === d.shown) return;
    d.shown = text;
    this.emit('draft', { taskId, runId, text, after: d.after });
  }

  /** The draft is old: its message is stored, or the turn ended without it. */
  private endDraft(runId: string) {
    const d = this.drafts.get(runId);
    if (!d) return;
    this.drafts.delete(runId);
    this.emit('draft', { taskId: d.taskId, runId, text: '', after: d.after });
  }

  /**
   * Write down which process serves a run, so a restart can find it. Clears the stamp when the
   * session has no process (it ended, or Codex sits between turns).
   */
  private stamp(runId: string, pid: number | undefined) {
    const s = pid === undefined ? null : stampOf(pid, this.procEnv);
    this.store.updateRun(runId, { agent_pid: s?.pid ?? null, agent_boot_id: s?.bootId ?? null, agent_started_at: s?.startedAt ?? null });
  }

  /** The process a run has open, as the row remembers it. */
  private stampOfRun(run: RunRow): ProcessStamp | null {
    return run.agent_pid && run.agent_boot_id && run.agent_started_at !== null
      ? { pid: run.agent_pid, bootId: run.agent_boot_id, startedAt: run.agent_started_at }
      : null;
  }

  /**
   * Is an agent process from an earlier daemon still working for this run?
   *
   * It can be. Closing its input makes Claude Code stop, but only once it is idle, so it finishes
   * the action it was on. Nothing else stops it, because the daemon that owned it is gone.
   */
  private strayProcess(run: RunRow): ProcessStamp | null {
    if (this.live.has(run.id)) return null; // this daemon owns it
    const stamp = this.stampOfRun(run);
    return stamp && isSameProcess(stamp, this.procEnv) ? stamp : null;
  }

  /** The agent finished a turn: decide whether the run is over, waiting for you, or still talking. */
  private onTurn(taskId: string, runId: string, t: TurnEnd) {
    this.endDraft(runId);
    const live = this.live.get(runId);
    if (!live || live.finished) return;
    this.store.updateRun(runId, { last_turn_at: Date.now() });
    if (t.usage) this.recordUsage(runId, live, t.usage);

    if (t.interrupted) {
      this.event(taskId, runId, 'system', { text: 'Stopped. Tell Claude Code what to do next.' });
      if (live.routes) this.markWaiting(taskId, runId, 'paused');
      return;
    }
    if (!live.routes) {
      // A chat with a finished run: nothing to route. Close once you stop talking.
      this.closeAfterGrace(live, () => {});
      return;
    }
    if (t.isError) {
      live.finished = true;
      live.session.end();
      return this.fault(taskId, runId, 'error', t.text || 'Claude Code hit an error.', usageReset(t.text ?? ''));
    }

    const parsed = parseAgentResult(t.text);
    const ends = parsed.hasOutcome && parsed.outcome !== 'needs_you';
    if (!ends && this.overBudget(taskId)) {
      live.finished = true;
      live.session.end();
      return this.finish(taskId, runId, 'over_budget');
    }
    if (!parsed.hasOutcome && live.humanSpoke) {
      // It answered you mid-conversation without finishing the step: wait for your reply.
      return this.markWaiting(taskId, runId, 'reply');
    }
    if (!parsed.hasOutcome) {
      // No OUTCOME line: a cut-off reply or a forgotten block. Never read that as done.
      if (!live.nudged) {
        live.nudged = true;
        this.event(taskId, runId, 'system', { text: 'Claude Code ended its turn with no OUTCOME line. Orstra asked it to finish the step.' });
        live.session.send(NUDGE);
        return;
      }
      this.event(taskId, runId, 'system', { text: 'Still no OUTCOME line. Tell Claude Code what to do next, or retry the step.' });
      return this.markWaiting(taskId, runId, 'no_outcome');
    }
    // A question isn't progress: record the entry only when the step actually ends.
    if (parsed.outcome === 'needs_you') return this.markWaiting(taskId, runId, 'question');
    this.store.updateRun(runId, { progress: JSON.stringify(parsed.progress) });
    this.event(taskId, runId, 'progress', parsed.progress);
    this.emit('progress', { taskId, runId, outcome: parsed.outcome });

    this.closeAfterGrace(live, () => this.finish(taskId, runId, parsed.outcome));
  }

  /** Add one turn's cost and tokens to the run. */
  private recordUsage(runId: string, live: Live, u: TurnUsage) {
    const run = this.store.run(runId);
    if (!run) return;
    const patch: Partial<RunRow> = { tokens_in: (run.tokens_in ?? 0) + u.tokensIn, tokens_out: (run.tokens_out ?? 0) + u.tokensOut };
    if (u.totalCostUsd !== undefined) patch.cost_usd = live.baseCost + u.totalCostUsd;
    this.store.updateRun(runId, patch);
  }

  /** true when the task's runs cost as much as its workflow's `budget_usd`, or more. Says so on the task. */
  private overBudget(taskId: string): boolean {
    const task = this.store.task(taskId);
    if (!task) return false;
    const cap = this.workflowFor(task).budgetUsd;
    if (cap === undefined) return false;
    const usd = this.store.taskCost(taskId).usd;
    if (usd < cap) return false;
    const money = (v: number) => '$' + v.toFixed(2);
    this.event(taskId, null, 'system', { text: `This task cost ${money(usd)}, which reaches its budget of ${money(cap)}. Orstra stopped the agent work. Raise budget_usd in the workflow, or retry to continue.` });
    return true;
  }

  /** Close the session unless you send another message within the grace period. */
  private closeAfterGrace(live: Live, then: () => void) {
    const seq = live.sendSeq;
    this.timers++;
    setTimeout(() => {
      this.timers--;
      if (live.finished || live.sendSeq !== seq) return;
      live.finished = true;
      live.session.end();
      then();
    }, this.opts.turnGraceMs ?? 1500);
  }

  private markWaiting(taskId: string, runId: string, reason: 'question' | 'reply' | 'paused' | 'no_outcome' | 'permission') {
    this.disarm(runId);
    this.store.updateRun(runId, { status: 'waiting', wait_reason: reason });
    this.project(taskId);
    this.pump();
  }

  /** The tools you allowed for every later call in this task. */
  private allowedTools(taskId: string): string[] {
    try { return JSON.parse(this.store.get(`perm-allow:${taskId}`) ?? '[]') as string[]; } catch { return []; }
  }

  /** The permission question open for a task, if any. */
  pendingPermission(taskId: string): PendingPermission | undefined {
    return [...this.permissions.values()].find((p) => p.taskId === taskId && !p.decision);
  }

  /**
   * An agent wants to run a tool that its permission mode does not allow. The run waits on you, and
   * the question goes to the Inbox. A tool you allowed for the whole task passes at once.
   */
  requestPermission(runId: string, tool: string, input: Record<string, unknown>): { id: string; decision?: PermissionDecision } {
    const run = this.store.run(runId);
    const task = run && this.store.task(run.task_id);
    const id = `p-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    if (!run || !task || task.status === 'stopped' || (run.status !== 'running' && run.status !== 'waiting')) {
      return { id, decision: { behavior: 'deny', message: 'This run is no longer active in Orstra.' } };
    }
    const summary = summarizeTool(tool, input);
    if (this.allowedTools(task.id).includes(tool)) {
      this.event(task.id, runId, 'system', { text: `Allowed ${tool}: ${summary} (you allowed ${tool} for this task).` });
      return { id, decision: { behavior: 'allow', updatedInput: input } };
    }
    this.permissions.set(id, { id, taskId: task.id, runId, tool, input, summary, ts: Date.now(), waiters: [] });
    this.event(task.id, runId, 'permission', { id, tool, summary });
    this.markWaiting(task.id, runId, 'permission');
    return { id };
  }

  /** Wait up to `ms` for the answer; null means "still open, ask again". */
  waitPermission(id: string, ms = 25_000): Promise<PermissionDecision | null> {
    const p = this.permissions.get(id);
    if (!p) return Promise.resolve({ behavior: 'deny', message: 'Orstra lost this question (it restarted). Ask again in your reply.' });
    if (p.decision) return Promise.resolve(p.decision);
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        p.waiters = p.waiters.filter((w) => w !== done);
        resolve(null);
      }, ms);
      t.unref?.();
      const done = (d: PermissionDecision) => {
        clearTimeout(t);
        resolve(d);
      };
      p.waiters.push(done);
    });
  }

  /** Your answer to a permission question. `always` allows that tool for the rest of the task. */
  answerPermission(id: string, allow: boolean, opts: { always?: boolean; message?: string; via?: Via } = {}) {
    const p = this.permissions.get(id);
    if (!p || p.decision) throw new Error('That permission question is no longer open.');
    const decision: PermissionDecision = allow
      ? { behavior: 'allow', updatedInput: p.input }
      : { behavior: 'deny', message: opts.message?.trim() || 'The user said no. Do not try this again; find another way or explain what you need.' };
    this.settle(p, decision);
    if (allow && opts.always) {
      const list = this.allowedTools(p.taskId);
      if (!list.includes(p.tool)) this.store.set(`perm-allow:${p.taskId}`, JSON.stringify([...list, p.tool]));
    }
    this.event(p.taskId, p.runId, 'you', { mode: 'permission', text: opts.message ?? '', allow, always: !!opts.always, tool: p.tool, via: opts.via });
    const run = this.store.run(p.runId);
    const task = this.store.task(p.taskId);
    if (run && task && run.status === 'waiting' && !task.stopped_at && this.live.has(p.runId)) {
      this.store.updateRun(p.runId, { status: 'running', wait_reason: null });
      const step = this.workflowFor(task).steps[run.step_id];
      if (step) this.arm(p.taskId, p.runId, step);
      this.project(p.taskId);
    }
  }

  private settle(p: PendingPermission, d: PermissionDecision) {
    p.decision = d;
    for (const w of p.waiters) w(d);
    p.waiters = [];
    const t = setTimeout(() => this.permissions.delete(p.id), 60_000);
    t.unref?.();
  }

  /** Close every open question of a run: its session is gone, so no one waits for the answer. */
  private dropPermissions(runId: string) {
    for (const p of this.permissions.values()) {
      if (p.runId === runId && !p.decision) this.settle(p, { behavior: 'deny', message: 'The run ended.' });
    }
  }

  private onClosed(taskId: string, runId: string, live: Live, res: { ok: boolean; error?: string }) {
    if (this.live.get(runId) === live) this.live.delete(runId);
    this.endDraft(runId);
    // The process is gone, so the stamp would only mislead the next restart.
    this.stamp(runId, undefined);
    this.dropPermissions(runId);
    // The session is gone, so a run that still waits now reads as paused rather than as live.
    this.project(taskId);
    if (live.finished || !live.routes) return;
    const run = this.store.run(runId);
    const task = this.store.task(taskId);
    if (!run || !task || task.status === 'stopped' || run.status === 'stopped') return;
    if (run.status === 'waiting') return; // it's waiting for you; your next message resumes the session
    this.fault(taskId, runId, 'crash', res.error ?? 'Claude Code exited before finishing the step.', usageReset(res.error ?? ''));
  }

  /** Start the clock on a run. It stops the run and sends the task to the Inbox (`timeout`) when it runs out. */
  private arm(taskId: string, runId: string, step: Step) {
    this.disarm(runId);
    const fallback = step.use === 'gate' ? this.opts.defaultTimeoutMs?.gate : this.opts.defaultTimeoutMs?.agent;
    const ms = step.timeoutMinutes !== undefined ? step.timeoutMinutes * 60_000 : fallback ?? 0;
    if (!ms) return;
    const t = setTimeout(() => this.onTimeout(taskId, runId, ms), ms);
    t.unref?.();
    this.deadlines.set(runId, t);
  }

  private disarm(runId: string) {
    const t = this.deadlines.get(runId);
    if (t) clearTimeout(t);
    this.deadlines.delete(runId);
  }

  private onTimeout(taskId: string, runId: string, ms: number) {
    this.deadlines.delete(runId);
    const run = this.store.run(runId);
    if (!run || run.status !== 'running') return;
    const mins = Math.round(ms / 60_000);
    this.timedOut.add(runId);
    this.event(taskId, runId, 'system', { text: `This step worked longer than its timeout (${mins ? `${mins} min` : `${ms} ms`}), so Orstra stopped it.` });
    const live = this.live.get(runId);
    if (live) {
      live.finished = true;
      live.session.kill();
      return this.fault(taskId, runId, 'timeout', 'The step timed out.');
    }
    // A gate: abort its command; execute() sees the timeout and finishes the run.
    this.controllers.get(runId)?.abort();
  }

  private async execute(task: TaskRow, run: RunRow) {
    const wf = this.workflowFor(task);
    const step = wf.steps[run.step_id];
    const cwd = task.worktree ?? process.cwd();
    if ((step.use === 'agent' || step.use === 'gate') && task.worktree && !existsSync(task.worktree)) {
      // A git.cleanup step or a cleanup removed it. Never run an agent in some other folder.
      this.event(task.id, run.id, 'system', { text: `The task's worktree at ${task.worktree} is gone, so this step cannot run.` });
      return this.finish(task.id, run.id, 'cant_do');
    }
    // Only a task whose workspace has setup commands still to run waits here; every other step starts at once.
    if ((step.use === 'agent' || step.use === 'gate') && this.setupCommands(task).length && !(await this.prepare(task, run))) return;

    if (step.use === 'agent') {
      if (this.overBudget(task.id)) return this.finish(task.id, run.id, 'over_budget');
      if (run.retries && run.session_id) {
        // A retry after a fault: the same session continues, so the work of the last try stays.
        this.store.updateRun(run.id, { head_before: task.worktree ? gitHead(task.worktree) : null });
        const live = this.openSession(task, run, { sessionId: run.session_id, resume: true, routes: true, model: step.model });
        this.arm(task.id, run.id, step);
        live.session.send(this.retryNote(task, run));
        return;
      }
      const sessionId = randomUUID();
      this.store.updateRun(run.id, { session_id: sessionId, head_before: task.worktree ? gitHead(task.worktree) : null });
      const inputs = this.stage(task, run);
      const live = this.openSession(task, { ...run, session_id: sessionId }, { sessionId, resume: false, routes: true, model: step.model });
      this.arm(task.id, run.id, step);
      live.session.send(this.buildPrompt(task, wf, step, run, inputs));
      return;
    }

    const ctrl = new AbortController();
    this.controllers.set(run.id, ctrl);
    const onEvent = (e: StreamEvent) => this.event(task.id, run.id, e.kind, e);
    try {
      if (step.use === 'gate') {
        this.stage(task, run);
        this.arm(task.id, run.id, step);
        const res = await this.exec.gate({ commands: step.run ?? [], cwd: taskCwd(task), env: this.envOf(task), onEvent, signal: ctrl.signal });
        this.disarm(run.id);
        if (this.timedOut.delete(run.id)) {
          this.store.updateRun(run.id, { output: res.output });
          return this.fault(task.id, run.id, 'timeout', 'The check timed out.');
        }
        if (ctrl.signal.aborted) return;
        this.store.updateRun(run.id, { output: res.output });
        return this.finish(task.id, run.id, res.pass ? 'pass' : 'fail');
      }

      if (step.use === 'human') {
        this.store.updateRun(run.id, { status: 'waiting' });
        this.project(task.id);
        this.event(task.id, run.id, 'system', { text: step.question ?? 'Waiting for your decision' });
        return;
      }

      if (step.use === 'switch') {
        const value = renderTemplate(step.value ?? '', this.context(task));
        const match = switchCase(Object.keys(step.on), value);
        this.event(task.id, run.id, 'system', { text: `Took the ${match} branch` });
        return this.finish(task.id, run.id, match);
      }

      if (step.use === 'action') {
        const res = runAction(step.action, {
          cwd, input: step.with ?? {},
          task: { title: task.title, ref: task.ref, description: task.description },
          progress: this.progressText(task, wf),
          beforeRemove: () => this.emit('cleanup', task.id),
        });
        this.store.updateRun(run.id, { output: res.text });
        if (res.prUrl) this.store.updateTask(task.id, { pr_url: res.prUrl });
        this.event(task.id, run.id, 'system', { text: res.text });
        return this.finish(task.id, run.id, res.outcome);
      }

      this.event(task.id, run.id, 'system', { text: `Step type "${step.use}" isn't built yet.` });
      return this.finish(task.id, run.id, 'cant_do');
    } finally {
      this.controllers.delete(run.id);
    }
  }

  /** The workspace's environment variables, for every agent and gate of the task. */
  private envOf(task: TaskRow): Record<string, string> | undefined {
    const ws = task.workspace_id ? this.store.workspace(task.workspace_id) : undefined;
    const env = ws ? workspaceView(ws).env : {};
    return Object.keys(env).length ? env : undefined;
  }

  /**
   * Run the workspace's setup commands in the task's worktree, once, before its first agent or gate
   * step. True when the step may go on. A failure ends the run with `setup_failed`, which no workflow
   * routes, so the task goes to your Inbox; a retry runs the setup again.
   */
  private setupCommands(task: TaskRow): string[] {
    const fresh = this.store.task(task.id) ?? task;
    if (!fresh.workspace_id || fresh.setup_at) return [];
    const ws = this.store.workspace(fresh.workspace_id);
    return ws ? workspaceView(ws).setup : [];
  }

  private async prepare(task: TaskRow, run: RunRow): Promise<boolean> {
    const fresh = this.store.task(task.id) ?? task;
    const ws = this.store.workspace(fresh.workspace_id!)!;
    const commands = this.setupCommands(task);
    const ctrl = new AbortController();
    this.controllers.set(run.id, ctrl);
    this.preparing.add(run.id);
    this.project(task.id);
    this.event(task.id, run.id, 'system', { text: `Setting up the worktree for ${ws.name}` });
    try {
      const res = await this.exec.gate({ commands, cwd: taskCwd(fresh), env: this.envOf(fresh), signal: ctrl.signal,
        onEvent: (e) => this.event(task.id, run.id, e.kind, e) });
      if (ctrl.signal.aborted) return false;
      if (!res.pass) {
        this.store.updateRun(run.id, { output: res.output });
        this.event(task.id, run.id, 'system', { text: 'The workspace setup failed, so this step did not start. Fix the setup on the Workspaces page, then retry the step.' });
        this.preparing.delete(run.id);
        this.finish(task.id, run.id, 'setup_failed');
        return false;
      }
      this.store.updateTask(task.id, { setup_at: Date.now() });
      this.event(task.id, run.id, 'system', { text: 'The workspace setup passed' });
      return true;
    } finally {
      this.preparing.delete(run.id);
      this.controllers.delete(run.id);
    }
  }

  /**
   * Copy what the run produced out of the worktree and record it. Artifacts never change how a run
   * ends or where the task goes: a step that keeps nothing moves on like any other.
   */
  private collect(task: TaskRow, run: RunRow, step: Step | undefined) {
    if (!step || !task.worktree) return;
    // Declared specs first, so a file they match keeps their name. Then the folder every agent and gate
    // step may write to without any workflow change.
    const specs = [...(step.artifacts ?? []), ...(step.use === 'agent' || step.use === 'gate' ? [DEFAULT_SPEC] : [])];
    if (!specs.length) return;
    let res;
    try {
      res = collectArtifacts({ worktree: task.worktree, specs, taskId: task.id, runId: run.id, since: run.started_at ?? 0, root: this.opts.artifactsRoot,
        seen: new Set(this.store.artifactsForTask(task.id).flatMap((a) => (a.sha256 ? [seenKey(a.name, a.sha256)] : []))) });
    } catch (err: any) {
      this.event(task.id, run.id, 'system', { text: `Could not collect this step’s artifacts: ${err?.message ?? err}` });
      return;
    }
    const now = Date.now();
    const row = (name: string, label: string, mime: string, bytes: number, state: ArtifactState, sha256: string | null, path: string | null) =>
      this.store.insertArtifact({ id: id('a'), task_id: task.id, run_id: run.id, step_id: run.step_id, name, label, mime, bytes, state, sha256, path, created_at: now });

    for (const s of res.saved) {
      if (s.skipped) row(s.name, s.skipped, s.mime, s.bytes, 'skipped', null, null);
      else row(s.name, s.label, s.mime, s.bytes, 'saved', s.sha256, s.path);
    }
    if (res.saved.length) {
      this.event(task.id, run.id, 'artifact', { files: res.saved.map((s) => ({ name: s.name, bytes: s.bytes, skipped: s.skipped ?? null })) });
    }
  }

  /** Record a run's outcome and follow the matching arrow. */
  private finish(taskId: string, runId: string, outcome: string) {
    this.disarm(runId);
    this.timedOut.delete(runId);
    const run = this.store.run(runId);
    const task = this.store.task(taskId);
    if (!run || !task || task.stopped_at) return;
    // A retry or a stop may have closed this run while its outcome was on the way. Routing it now
    // would open a second run beside the one that replaced it, which the database refuses.
    if (!OPEN_STATUSES.has(run.status)) return;
    const okOutcomes = new Set(['done', 'pass', 'ok', 'approved', 'started']);
    const wf = this.workflowFor(task);
    this.collect(task, run, wf.steps[run.step_id]);
    const counts = JSON.parse(task.edge_counts) as Record<string, number>;
    const next = route(wf, run.step_id, outcome, counts);
    // What the router decided is stored on the run, so a later read never has to ask the workflow
    // file again. An edit to that file cannot change what the board says about a task that ended.
    const routed = next.type === 'goto' ? `goto:${next.step}` : next.type === 'end' ? 'end' : `block:${next.reason}`;
    this.store.updateRun(runId, { status: okOutcomes.has(outcome) || run.kind === 'switch' || run.kind === 'human' ? 'done' : 'failed', outcome, ended_at: Date.now(), routed });

    if (next.type === 'goto') {
      counts[next.edge] = (counts[next.edge] ?? 0) + 1;
      this.store.updateTask(taskId, { edge_counts: JSON.stringify(counts) });
      this.event(taskId, runId, 'system', { text: `${outcome} → ${wf.steps[next.step].title ?? next.step}` });
      this.queueStep(this.store.task(taskId)!, next.step);
    } else if (next.type === 'end') {
      this.event(taskId, runId, 'system', { text: `${outcome} → finished` });
    } else {
      this.event(taskId, runId, 'system', { text: `${outcome} → needs you (${next.reason.replace('_', ' ')})` });
    }
    this.project(taskId);
    this.pump();
  }

  /** The agent run that works on a task right now: its row says running, or its session is still open. */
  private working(taskId: string): RunRow | undefined {
    return this.store.runsForTask(taskId).find((r) => {
      if (r.kind !== 'agent') return false;
      const live = this.live.get(r.id);
      return r.status === 'running' || (!!live && !live.finished);
    });
  }

  /** A human step's decision. Each choice is an outgoing arrow; the comment goes to whichever step runs next. */
  decide(runId: string, choice: string, comment?: string, via?: Via) {
    const run = this.store.run(runId);
    if (!run || run.status !== 'waiting' || run.kind !== 'human') throw new Error('That decision is no longer waiting.');
    // A decision never stands while the agent works: approval merges the branch, and the diff still moves.
    if (this.working(run.task_id)) throw new Error('The agent is working on this task again. Wait for it to finish, then decide.');
    const task = this.store.task(run.task_id)!;
    this.event(task.id, runId, 'you', { mode: 'decision', choice, text: comment ?? '', via });
    if (comment) this.store.addEvent(task.id, runId, 'note', { text: comment });
    this.finish(task.id, runId, choice);
  }

  /** The agent run a chat message goes to: the one working or waiting on you, else the latest one with a session. */
  private chatTarget(taskId: string, runId?: string): RunRow | undefined {
    const runs = this.store.runsForTask(taskId).filter((r) => r.kind === 'agent' && r.session_id);
    if (runId) return runs.find((r) => r.id === runId);
    return runs.find((r) => r.status === 'running' || r.status === 'waiting') ?? runs[runs.length - 1];
  }

  /**
   * You chatted to an agent whose run had ended while the task waited on you: its step takes the task
   * back. The same session continues in a new run row, so this round of work gets its own progress
   * entry and its outcome moves the workflow again.
   *
   * Nothing else may wait while the agent works. A decision that stayed open could be approved against
   * a diff the agent still changes, and an approval merges the branch on its own.
   */
  private sendBack(task: TaskRow, target: RunRow): RunRow {
    const title = this.stepTitle(task, target.step_id);
    const closing = this.store.openRuns().filter((r) => r.task_id === task.id && r.id !== target.id);
    this.closeOpenRuns(task.id, 'reopened', target.id);
    for (const r of closing) {
      this.event(task.id, r.id, 'system', { text: `${r.kind === 'human' ? 'This decision closed' : 'This step closed'} without an answer: your message sent ${title} back to the agent.` });
    }
    this.killLive(target.id);
    const attempt = this.store.runsForTask(task.id).filter((r) => r.step_id === target.step_id).length + 1;
    const now = Date.now();
    const run: RunRow = {
      id: id('r'), task_id: task.id, step_id: target.step_id, kind: target.kind, attempt, status: 'running', outcome: null,
      agent: target.agent, session_id: target.session_id, progress: null, output: null, created_at: now, started_at: now, ended_at: null,
      last_turn_at: null, wait_reason: null, routed: null, cost_usd: null, tokens_in: null, tokens_out: null, agent_pid: null, agent_boot_id: null, agent_started_at: null, head_before: null, head_after: null, log_uuid: null, resumed_at: null,
    };
    this.store.insertRun(run);
    return run;
  }

  /** The step's name for a sentence. A workflow file that moved must not drop your message. */
  private stepTitle(task: TaskRow, stepId: string): string {
    try {
      return this.workflow(task.workflow_path).steps[stepId]?.title ?? stepId;
    } catch {
      return stepId;
    }
  }

  /** Drop a run we must not talk to any more: its clock, its held messages and its session. */
  private killLive(runId: string) {
    this.disarm(runId);
    this.held.delete(runId);
    const live = this.live.get(runId);
    if (!live) return;
    live.finished = true;
    live.session.kill();
    this.live.delete(runId);
  }

  /** What a resumed session is told after your message, so this round ends as a run of its own. */
  private backOnStep(task: TaskRow, run: RunRow): string {
    return [
      '--- Orstra ---',
      `Your message put ${this.stepTitle(task, run.step_id)} back on you. This is attempt ${run.attempt} of that step, and it is a run of its own: how it ends moves the workflow.`,
      FINISH_INSTRUCTIONS.trim(),
    ].join('\n\n');
  }

  /**
   * chat: goes straight into the agent's session (read after its current action). If the session isn't
   * running any more, the same session resumes. note: handed to a step's next run. ask: a fork answers.
   *
   * `files` are attachments already written into the worktree. The agent gets their paths at the end
   * of the message; the event keeps your text alone, so the chat row stays readable.
   */
  async message(taskId: string, text: string, mode: MessageMode, opts: { runId?: string; stepId?: string; via?: Via; files?: Attachment[] } = {}) {
    const task = this.store.task(taskId);
    if (!task) throw new Error('No such task.');
    this.assertActive(task);
    const files = opts.files ?? [];
    // What the agent reads. With no attachment it is your text, byte for byte.
    const body = withFiles(text, files);
    const said = files.length ? { text, files } : { text };

    if (mode === 'note') {
      const step = opts.stepId ?? task.current_step ?? undefined;
      this.event(taskId, null, 'you', { mode: 'note', ...said, step: step ?? null, via: opts.via });
      this.store.addEvent(taskId, null, 'note', { text: body, step });
      return;
    }

    const target = this.chatTarget(taskId, opts.runId);
    if (mode === 'ask') {
      this.event(taskId, target?.id ?? null, 'you', { mode: 'ask', ...said });
      if (!target?.session_id) return this.event(taskId, null, 'aside', { text: 'There is no agent session to ask yet.' });
      const answer = await this.exec.ask(target.session_id, taskCwd(task), body, (target.agent as 'claude-code' | 'codex' | null) ?? 'claude-code');
      return this.event(taskId, target.id, 'aside', { text: answer });
    }

    // chat
    if (!target?.session_id) {
      this.event(taskId, null, 'you', { mode: 'note', ...said, step: task.current_step });
      this.store.addEvent(taskId, null, 'note', { text: body });
      return this.event(taskId, null, 'system', { text: 'No agent has started yet. Your message goes to the next agent step.' });
    }
    // owns: the run still holds its step, so your message lands in the run it already has.
    const owns = target.status === 'running' || target.status === 'waiting';
    // open: a done or stopped task reopens through a re-run only, never through one message.
    const open = task.status === 'running' || task.status === 'needs_you';
    // elsewhere: another run moves the task already, so this ended run takes the step back from nobody.
    const elsewhere = this.store.runsForTask(taskId).some((r) => r.id !== target.id && (r.status === 'running' || r.status === 'queued'));
    const routes = open && (owns || !elsewhere);

    // A run that waits on you takes a slot again when it works. With no free slot, the message waits.
    if (target.status === 'waiting' && open && this.busySlots().length >= this.opts.slots) {
      this.event(taskId, target.id, 'you', { mode: 'chat', ...said, via: opts.via });
      const list = this.held.get(target.id) ?? [];
      list.push({ taskId, body });
      this.held.set(target.id, list);
      return this.event(taskId, target.id, 'system', { text: `All ${this.opts.slots} slots are busy. Your message goes in when one is free.` });
    }

    // Your message hangs on the run that answers it, so 1 transcript holds the round.
    const run = !owns && routes ? this.sendBack(task, target) : target;
    this.event(taskId, run.id, 'you', { mode: 'chat', ...said, via: opts.via });
    if (run !== target) {
      this.event(taskId, run.id, 'system', { text: `Your message sent ${this.stepTitle(task, run.step_id)} back to the agent (attempt ${run.attempt}). The same session continues, and how it ends moves the workflow.` });
    }
    if (!routes) this.event(taskId, target.id, 'system', { text: chatOnlyText(task) });
    this.deliver(task, target, body, { run, routes });
  }

  /** Put a chat message into a run's session: resume the session if it is closed, and start its clock again. */
  private deliver(task: TaskRow, target: RunRow, body: string, opts: { run?: RunRow; routes?: boolean } = {}) {
    const taskId = task.id;
    // `run` differs from `target` when your message sent an ended step back to its agent.
    const run = opts.run ?? target;
    const routes = opts.routes ?? true;
    if (run === target && routes) this.store.updateRun(target.id, { status: 'running', wait_reason: null });

    let live = this.live.get(run.id);
    const step = this.workflowFor(task).steps[run.step_id];
    if (!live) {
      // A process from an earlier daemon can still hold this session. Resuming it now would put 2
      // agents in one worktree, so refuse and say which process to deal with.
      const stray = this.strayProcess(run);
      if (stray) {
        this.event(taskId, run.id, 'system', { text: `${agentName(run)} from an earlier Orstra still runs on this session (pid ${stray.pid}). Orstra did not send your message. Stop that process, or retry the step.` });
        throw new Error(`An earlier ${agentName(run)} process (pid ${stray.pid}) still holds this session. Stop it, or retry the step.`);
      }
      live = this.openSession(task, run, { sessionId: target.session_id!, resume: true, routes, model: step?.model });
    }
    // The run works again, so its clock starts again.
    if (routes && step) this.arm(taskId, run.id, step);
    live.humanSpoke = true;
    live.sendSeq++;
    live.session.send(run === target ? body : `${body}\n\n${this.backOnStep(task, run)}`);
    // After the session is open, never before: a run that is running with no session reads as paused.
    this.project(taskId);
  }

  /**
   * Close every agent session, for a daemon that is going down on purpose.
   *
   * Each one gets its input closed first, so the agent stops at the end of its current action and
   * writes nothing half way. One that will not go is killed. After this a restart finds no stray
   * process, and the sweep in `recover()` is left for a crash.
   */
  async shutdown(graceMs = 5_000): Promise<void> {
    // A gate's commands run in their own process group, so Ctrl-C never reaches them: stop them here.
    // The run stays `running`, and the next daemon runs the gate again (see recover()).
    for (const ctrl of this.controllers.values()) ctrl.abort();
    const open = [...this.live.entries()];
    for (const [runId, live] of open) {
      this.disarm(runId);
      live.finished = true;
      live.session.end();
    }
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.all(open.map(([, l]) => l.session.closed)),
      new Promise((r) => { timer = setTimeout(r, graceMs); }),
    ]);
    clearTimeout(timer);
    for (const [, live] of open) {
      try {
        live.session.kill();
      } catch {
        /* already gone */
      }
    }
  }

  /** Stop the agent's current turn; the session stays open for your next message. */
  interrupt(taskId: string) {
    const target = this.chatTarget(taskId);
    const live = target && this.live.get(target.id);
    if (!target || !live) throw new Error('No agent is working on this task right now.');
    this.event(taskId, target.id, 'you', { mode: 'interrupt', text: '' });
    live.session.interrupt();
  }

  private closeLive(taskId: string) {
    for (const r of this.store.runsForTask(taskId)) this.killLive(r.id);
  }

  /**
   * End every run that still holds the task, so only 1 ever does. `queued` counts: a run that never
   * started still holds the task, and the database refuses a second open run beside it.
   */
  private closeOpenRuns(taskId: string, outcome: string | null, exceptRunId?: string) {
    for (const r of this.store.openRuns()) {
      if (r.task_id !== taskId || r.id === exceptRunId) continue;
      this.killLive(r.id);
      this.controllers.get(r.id)?.abort();
      this.store.updateRun(r.id, { status: 'stopped', ended_at: Date.now(), ...(outcome ? { outcome } : {}) });
    }
  }

  /** Run a step again (default: where the task is now) as a fresh session. */
  retry(taskId: string, stepId?: string, note?: string, via?: Via) {
    const task = this.store.task(taskId);
    if (!task) throw new Error('No such task.');
    this.assertActive(task);
    const step = stepId ?? task.current_step;
    if (!step) throw new Error('Nothing to retry.');
    this.closeOpenRuns(taskId, null);
    // A re-run is how you start a stopped task again, so it lifts the stop.
    this.store.updateTask(taskId, { stopped_at: null });
    this.project(taskId);
    if (note) this.store.addEvent(taskId, null, 'note', { text: note, step });
    this.event(taskId, null, 'system', { text: `Retrying ${this.workflowFor(task).steps[step]?.title ?? step}${byCos(via)}` });
    this.queueStep(task, step);
    this.pump();
  }

  /** Archive a task, or bring it back. Archived tasks leave the lists; nothing else changes. */
  archive(taskId: string, archived = true) {
    const task = this.store.task(taskId);
    if (!task) throw new Error('No such task.');
    if (archived && (task.status === 'running' || task.status === 'needs_you')) throw new Error('Stop the task or let it finish before you archive it.');
    this.store.updateTask(taskId, { archived_at: archived ? Date.now() : null });
    this.event(taskId, null, 'system', { text: archived ? 'Archived' : 'Back from the archive' });
  }

  /**
   * Remove a finished task's worktree (and its branch when merged), then archive it. Refuses, and
   * changes nothing, when work would be lost and `force` is not set. See cleanup.ts.
   */
  cleanup(taskId: string, opts: { force?: boolean } = {}): string {
    const task = this.store.task(taskId);
    if (!task) throw new Error('No such task.');
    if (task.status === 'running' || task.status === 'needs_you') throw new Error('Stop the task or let it finish before you clean it up.');
    // The side viewer's shells and dev server work in the worktree: they stop just before it goes (server.ts listens).
    const res = cleanupWorktree(task.worktree, { ...opts, beforeRemove: () => this.emit('cleanup', taskId) });
    if (res.outcome === 'refused') throw new Error(res.text);
    this.store.updateTask(taskId, { archived_at: Date.now() });
    this.event(taskId, null, 'system', { text: `${res.text} Archived the task.` });
    return res.text;
  }

  private assertActive(task: TaskRow) {
    if (task.archived_at) throw new Error('This task is archived. Bring it back from the archive first.');
  }

  stop(taskId: string, via?: Via) {
    this.closeOpenRuns(taskId, null);
    this.store.updateTask(taskId, { stopped_at: Date.now() });
    this.project(taskId);
    this.event(taskId, null, 'system', { text: `Stopped${byCos(via)}` });
    this.pump();
  }
}
