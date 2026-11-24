import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { FINISH_INSTRUCTIONS, parseAgentResult, parseWorkflow, renderTemplate, route, stripProgressBlock, type Progress, type Step, type Workflow } from '@orstra/core';
import { withFiles, type Attachment } from './attachments.ts';
import type { Executors, LiveSession, StreamEvent, TurnEnd } from './executors.ts';
import type { RunRow, Store, TaskRow } from './db.ts';
import { locateWorkflow } from './workflows.ts';
import { runAction } from './actions.ts';

export interface StartTaskInput {
  workflowPath: string;
  title: string;
  description?: string;
  ref?: string;
  repo?: string;
  /** Who asked: 'cos' when the chief of staff started it. */
  via?: Via;
}

/** chat = talk to the agent's session; note = hand to a step's next run; ask = a forked copy answers. */
export type MessageMode = 'chat' | 'note' | 'ask';

/** Set when the chief of staff acted for you; shown on the task. */
export type Via = 'cos' | undefined;
const byCos = (via: Via) => (via === 'cos' ? ' (by your chief of staff)' : '');

export interface RunnerOptions {
  slots: number;
  createWorktree: (taskId: string, repo?: string) => string;
  /** After an agent finishes a turn with an outcome, wait this long for a follow-up message before closing it. */
  turnGraceMs?: number;
}

interface Live {
  session: LiveSession;
  /** true when this session's outcome moves the task; false for a chat with an already-finished run. */
  routes: boolean;
  humanSpoke: boolean;
  sendSeq: number;
  finished: boolean;
}

const id = (p: string) => `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const SLOT_KINDS = new Set(['agent', 'gate']);

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
  private controllers = new Map<string, AbortController>();
  private live = new Map<string, Live>();
  private timers = 0;

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

  /** Drop the cached parse of a workflow file after it was edited, so the next step reads the new version. */
  forgetWorkflow(path: string) {
    this.workflows.delete(path);
  }

  isLive(runId: string): boolean {
    return this.live.has(runId);
  }

  private changed(taskId: string) {
    this.emit('change', { taskId });
  }

  private event(taskId: string, runId: string | null, kind: string, payload: unknown) {
    this.store.addEvent(taskId, runId, kind, payload);
    this.changed(taskId);
  }

  /**
   * After a restart no session process survives. Agent runs become "waiting": message them and the
   * same session resumes. Other running steps go to the inbox.
   */
  recover() {
    for (const r of this.store.runsByStatus('running')) {
      if (r.kind === 'agent' && r.session_id) {
        this.store.updateRun(r.id, { status: 'waiting' });
        this.store.updateTask(r.task_id, { status: 'needs_you', inbox_reason: 'restarted', current_step: r.step_id });
        this.store.addEvent(r.task_id, r.id, 'system', { text: 'Orstra restarted mid-run. Message Claude Code to pick the session back up, or retry the step.' });
      } else {
        this.store.updateRun(r.id, { status: 'failed', outcome: 'interrupted', ended_at: Date.now() });
        this.store.updateTask(r.task_id, { status: 'needs_you', inbox_reason: 'restarted', current_step: r.step_id });
        this.store.addEvent(r.task_id, r.id, 'system', { text: 'Orstra restarted while this step was running. Retry it or stop the task.' });
      }
    }
    this.pump();
  }

  startTask(input: StartTaskInput): TaskRow {
    const wf = this.workflow(input.workflowPath);
    const taskId = id('t');
    const worktree = this.opts.createWorktree(taskId, input.repo ?? wf.repo);
    const now = Date.now();
    const task: TaskRow = {
      id: taskId, ref: input.ref ?? null, title: input.title, description: input.description ?? '',
      workflow_path: input.workflowPath, workflow_name: wf.name, status: 'running', current_step: wf.start,
      inbox_reason: null, edge_counts: '{}', worktree, created_at: now, updated_at: now, stopped_at: null,
    };
    this.store.insertTask(task);
    this.event(taskId, null, 'system', { text: `Started ${wf.name}${byCos(input.via)}` });
    this.queueStep(task, wf.start);
    this.pump();
    return task;
  }

  private queueStep(task: TaskRow, stepId: string) {
    const step = this.workflow(task.workflow_path).steps[stepId];
    const attempt = this.store.runsForTask(task.id).filter((r) => r.step_id === stepId).length + 1;
    const run: RunRow = {
      id: id('r'), task_id: task.id, step_id: stepId, kind: step.use, attempt, status: 'queued', outcome: null,
      agent: step.use === 'agent' ? step.agent ?? 'claude-code' : null, session_id: null, progress: null, output: null,
      created_at: Date.now(), started_at: null, ended_at: null, last_turn_at: null, wait_reason: null, routed: null,
    };
    this.store.insertRun(run);
    this.store.updateTask(task.id, { current_step: stepId, status: 'running', inbox_reason: null });
    this.changed(task.id);
  }

  /** Start queued runs while there are free slots. Human, switch and action steps don't take a slot. */
  pump() {
    let busy = this.store.runsByStatus('running').filter((r) => SLOT_KINDS.has(r.kind)).length;
    for (const run of this.store.runsByStatus('queued')) {
      const task = this.store.task(run.task_id);
      if (!task || task.status === 'stopped') continue;
      if (SLOT_KINDS.has(run.kind)) {
        if (busy >= this.opts.slots) continue;
        busy++;
      }
      this.store.updateRun(run.id, { status: 'running', started_at: Date.now() });
      this.execute(task, { ...run, status: 'running' }).catch((err) => {
        this.event(task.id, run.id, 'system', { text: `Run crashed: ${err?.message ?? err}` });
        this.finish(task.id, run.id, 'cant_do');
      });
    }
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
    const trigger = { title: task.title, description: task.description, ref: task.ref, id: task.ref ?? task.id };
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

  private buildPrompt(task: TaskRow, wf: Workflow, step: Step, run: RunRow): string {
    const notes = this.notesFor(task, step, run);
    return [
      renderTemplate(step.prompt ?? '', this.context(task)),
      '---',
      `Task: ${task.ref ? task.ref + ' ' : ''}${task.title}`,
      task.description && `Description:\n${task.description}`,
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
      if (e.kind === 'message') {
        const text = stripProgressBlock(e.text);
        if (text) this.event(task.id, run.id, 'message', { kind: 'message', text });
        return;
      }
      this.event(task.id, run.id, e.kind, e);
    };
    const live: Live = { session: null as unknown as LiveSession, routes: opts.routes, humanSpoke: false, sendSeq: 0, finished: false };
    live.session = this.exec.session((run.agent as 'claude-code' | 'codex') ?? 'claude-code', {
      cwd: task.worktree ?? process.cwd(), sessionId: opts.sessionId, resume: opts.resume, model: opts.model,
      onEvent, onTurn: (t) => this.onTurn(task.id, run.id, t),
    });
    this.live.set(run.id, live);
    this.changed(task.id);
    void live.session.closed.then((res) => this.onClosed(task.id, run.id, live, res));
    return live;
  }

  /** The agent finished a turn: decide whether the run is over, waiting for you, or still talking. */
  private onTurn(taskId: string, runId: string, t: TurnEnd) {
    const live = this.live.get(runId);
    if (!live || live.finished) return;
    this.store.updateRun(runId, { last_turn_at: Date.now() });

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
      this.event(taskId, runId, 'system', { text: t.text || 'Claude Code hit an error.' });
      live.finished = true;
      live.session.end();
      return this.finish(taskId, runId, 'cant_do');
    }

    const parsed = parseAgentResult(t.text);
    if (!parsed.hasOutcome && live.humanSpoke) {
      // It answered you mid-conversation without finishing the step: wait for your reply.
      return this.markWaiting(taskId, runId, 'reply');
    }
    // A question isn't progress: record the entry only when the step actually ends.
    if (parsed.outcome === 'needs_you') return this.markWaiting(taskId, runId, 'question');
    this.store.updateRun(runId, { progress: JSON.stringify(parsed.progress) });
    this.event(taskId, runId, 'progress', parsed.progress);

    this.closeAfterGrace(live, () => this.finish(taskId, runId, parsed.outcome));
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

  private markWaiting(taskId: string, runId: string, reason: 'question' | 'reply' | 'paused') {
    this.store.updateRun(runId, { status: 'waiting', wait_reason: reason });
    this.store.updateTask(taskId, { status: 'needs_you', inbox_reason: reason });
    this.changed(taskId);
    this.pump();
  }

  private onClosed(taskId: string, runId: string, live: Live, res: { ok: boolean; error?: string }) {
    if (this.live.get(runId) === live) this.live.delete(runId);
    this.changed(taskId);
    if (live.finished || !live.routes) return;
    const run = this.store.run(runId);
    const task = this.store.task(taskId);
    if (!run || !task || task.status === 'stopped' || run.status === 'stopped') return;
    if (run.status === 'waiting') return; // it's waiting for you; your next message resumes the session
    this.event(taskId, runId, 'system', { text: res.error ?? 'Claude Code exited before finishing the step.' });
    this.finish(taskId, runId, 'cant_do');
  }

  private async execute(task: TaskRow, run: RunRow) {
    const wf = this.workflow(task.workflow_path);
    const step = wf.steps[run.step_id];
    const cwd = task.worktree ?? process.cwd();

    if (step.use === 'agent') {
      const sessionId = randomUUID();
      this.store.updateRun(run.id, { session_id: sessionId });
      const live = this.openSession(task, { ...run, session_id: sessionId }, { sessionId, resume: false, routes: true, model: step.model });
      live.session.send(this.buildPrompt(task, wf, step, run));
      return;
    }

    const ctrl = new AbortController();
    this.controllers.set(run.id, ctrl);
    const onEvent = (e: StreamEvent) => this.event(task.id, run.id, e.kind, e);
    try {
      if (step.use === 'gate') {
        const res = await this.exec.gate({ commands: step.run ?? [], cwd, onEvent, signal: ctrl.signal });
        if (ctrl.signal.aborted) return;
        this.store.updateRun(run.id, { output: res.output });
        return this.finish(task.id, run.id, res.pass ? 'pass' : 'fail');
      }

      if (step.use === 'human') {
        this.store.updateRun(run.id, { status: 'waiting' });
        this.store.updateTask(task.id, { status: 'needs_you', inbox_reason: 'decision' });
        this.event(task.id, run.id, 'system', { text: step.question ?? 'Waiting for your decision' });
        return;
      }

      if (step.use === 'switch') {
        const value = renderTemplate(step.value ?? '', this.context(task)).toLowerCase();
        const match = Object.keys(step.on).find((k) => k !== 'default' && value.includes(k.toLowerCase()));
        this.event(task.id, run.id, 'system', { text: `Took the ${match ?? 'default'} branch` });
        return this.finish(task.id, run.id, match ?? 'default');
      }

      if (step.use === 'action') {
        const res = runAction(step.action, { cwd, input: step.with ?? {} });
        this.store.updateRun(run.id, { output: res.text });
        this.event(task.id, run.id, 'system', { text: res.text });
        return this.finish(task.id, run.id, res.outcome);
      }

      this.event(task.id, run.id, 'system', { text: `Step type "${step.use}" isn't built yet.` });
      return this.finish(task.id, run.id, 'cant_do');
    } finally {
      this.controllers.delete(run.id);
    }
  }

  /** Record a run's outcome and follow the matching arrow. */
  private finish(taskId: string, runId: string, outcome: string) {
    const run = this.store.run(runId);
    const task = this.store.task(taskId);
    if (!run || !task || task.status === 'stopped') return;
    const okOutcomes = new Set(['done', 'pass', 'ok', 'approved', 'started']);
    const wf = this.workflow(task.workflow_path);
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
      this.store.updateTask(taskId, { status: 'done', current_step: null, inbox_reason: null });
      this.event(taskId, runId, 'system', { text: `${outcome} → finished` });
    } else {
      this.store.updateTask(taskId, { status: 'needs_you', inbox_reason: next.reason, current_step: run.step_id });
      this.event(taskId, runId, 'system', { text: `${outcome} → needs you (${next.reason.replace('_', ' ')})` });
    }
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
      last_turn_at: null, wait_reason: null, routed: null,
    };
    this.store.insertRun(run);
    this.store.updateTask(task.id, { status: 'running', inbox_reason: null, current_step: target.step_id });
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

  /** Drop a session we must not talk to any more. Its turn no longer counts. */
  private killLive(runId: string) {
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
      const answer = await this.exec.ask(target.session_id, task.worktree ?? process.cwd(), body);
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

    if (owns && routes) {
      this.store.updateRun(target.id, { status: 'running' });
      this.store.updateTask(taskId, { status: 'running', inbox_reason: null, current_step: target.step_id });
    }
    // Your message hangs on the run that answers it, so one transcript holds the round.
    const run = !owns && routes ? this.sendBack(task, target) : target;
    this.event(taskId, run.id, 'you', { mode: 'chat', ...said, via: opts.via });
    if (run !== target) {
      this.event(taskId, run.id, 'system', { text: `Your message sent ${this.stepTitle(task, run.step_id)} back to the agent (attempt ${run.attempt}). The same session continues, and how it ends moves the workflow.` });
    }
    if (!routes) this.event(taskId, target.id, 'system', { text: chatOnlyText(task) });

    let live = this.live.get(run.id);
    if (!live) {
      const step = this.workflow(task.workflow_path).steps[run.step_id];
      live = this.openSession(task, run, { sessionId: target.session_id, resume: true, routes, model: step?.model });
    }
    live.humanSpoke = true;
    live.sendSeq++;
    live.session.send(run === target ? body : `${body}\n\n${this.backOnStep(task, run)}`);
    this.changed(taskId);
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
    const step = stepId ?? task.current_step;
    if (!step) throw new Error('Nothing to retry.');
    this.closeOpenRuns(taskId, null);
    // A re-run is how you start a stopped task again, so it lifts the stop.
    this.store.updateTask(taskId, { stopped_at: null });
    if (note) this.store.addEvent(taskId, null, 'note', { text: note, step });
    this.event(taskId, null, 'system', { text: `Retrying ${this.workflow(task.workflow_path).steps[step]?.title ?? step}${byCos(via)}` });
    this.queueStep(task, step);
    this.pump();
  }

  stop(taskId: string, via?: Via) {
    this.closeOpenRuns(taskId, null);
    this.store.updateTask(taskId, { status: 'stopped', stopped_at: Date.now() });
    this.event(taskId, null, 'system', { text: `Stopped${byCos(via)}` });
    this.pump();
  }
}
