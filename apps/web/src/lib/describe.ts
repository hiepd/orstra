import type { RunView, TaskDetail } from '../api';
import { AGENTS, reasonText } from './format';
import { taskState, type TaskState } from './taskState';
import { ago, clock } from './time';

const joinSteps = (names: string[]) => (names.length <= 2 ? names.join(', then ') : `${names[0]}, then ${names[1]}, then ${names.length - 2} more`);

/** The run that says where the task is: the one working or waiting on you, else the latest at its current step. */
export function currentRun(task: TaskDetail): RunView | undefined {
  const byId = (id?: string | null) => (id ? task.runs.find((r) => r.id === id) : undefined);
  return (
    byId(task.workingRunId) ??
    byId(task.awaiting?.runId) ??
    (task.currentStep ? [...task.runs].reverse().find((r) => r.stepId === task.currentStep) : undefined) ??
    task.runs[task.runs.length - 1]
  );
}

/**
 * The heading of the card an agent run puts on the task page. A session you stopped and a session
 * that died with the daemon both wait on you with the reason `paused`; only the state tells them apart.
 */
export function awaitingTitle(state: TaskState, reason: string | null): string {
  if (state === 'paused') return 'Claude Code’s session is closed';
  if (reason === 'question') return 'Claude Code is asking';
  if (reason === 'reply') return 'Claude Code replied';
  if (reason === 'paused') return 'You stopped Claude Code';
  if (reason === 'permission') return 'Claude Code needs your OK';
  if (reason === 'no_outcome') return 'Claude Code ended without an outcome';
  return 'Claude Code is waiting for you';
}

/** Two plain sentences for the top of a task: what is happening now, and what comes next. */
export function describeTask(task: TaskDetail): { now: string; next: string } {
  const state = taskState(task);
  const run = currentRun(task);
  const step = task.currentStepTitle ?? run?.stepTitle ?? 'the first step';
  const attempt = run && run.attempt > 1 ? ` (attempt ${run.attempt})` : '';
  const agent = AGENTS[run?.agent ?? task.agent ?? 'claude-code'].name;
  const todo = task.track.filter((s) => s.state === 'todo').map((s) => s.title);
  const after = todo.length ? joinSteps(todo) : 'Nothing; this is the last step';

  switch (state) {
    case 'working':
      return {
        now: run?.kind === 'gate' ? `${step} is running${attempt}: its checks are in progress.` : run?.kind === 'agent' ? `${step} is running${attempt}. ${agent} is working on it.` : `${step} is running${attempt}.`,
        next: `${after}.`,
      };
    case 'queued':
      if (run?.notBefore && run.notBefore > Date.now()) {
        return { now: `${step} failed for a reason outside the work, so Orstra retries it at ${clock(run.notBefore)}${run.retries ? ` (retry ${run.retries})` : ''}.`, next: todo.length ? `${joinSteps(todo)}.` : 'Nothing after it.' };
      }
      return { now: `${step} is queued${attempt}. It starts on its own when a slot is free.`, next: todo.length ? `${joinSteps(todo)}.` : 'Nothing after it.' };
    case 'decision':
      return { now: `Waiting for your decision at ${step}.`, next: 'Depends on what you choose.' };
    case 'sleeping':
      return {
        now: run?.kind === 'workflow'
          ? `${step} waits for the tasks it started.`
          : run?.callbackUrl
            ? `${step} waits for an outside system to call back${run.wakeAt ? `, until ${clock(run.wakeAt)}` : ''}.`
            : `${step} waits${run?.wakeAt ? ` until ${clock(run.wakeAt)}` : ''}.`,
        next: `It moves on by itself. Then ${todo.length ? joinSteps(todo) : 'the task finishes'}.`,
      };
    case 'checks':
      return { now: `${step} is running${attempt}: its checks are in progress.`, next: `${after}.` };
    case 'paused': {
      const since = task.lastTurnAt ? ` Its last turn was ${ago(task.lastTurnAt)}.` : '';
      return {
        now: `${agent}'s session for ${step}${attempt} is closed.${since} Message it in Chat and it picks the work back up, or re-run the step.`,
        next: `When it picks the work back up, ${todo.length ? joinSteps(todo) : 'the task finishes'}.`,
      };
    }
    case 'waiting_you': {
      const r = task.stateReason;
      const now =
        r === 'reply'
          ? `${agent} answered you during ${step}${attempt} and is waiting for your reply.`
          : r === 'paused'
            ? `You stopped ${agent} during ${step}${attempt}. It is waiting for you to say what to do next.`
            : r === 'permission'
              ? `${agent} wants to use a tool during ${step}${attempt} that needs your OK.`
              : r === 'no_outcome'
                ? `${agent} ended its turn during ${step}${attempt} without saying whether the step is done.`
                : `${agent} asked a question during ${step}${attempt} and is waiting for your answer.`;
      if (r === 'permission') return { now, next: `When you allow or refuse it, the same session continues. Then ${todo.length ? joinSteps(todo) : 'the task finishes'}.` };
      return { now, next: `When you reply in Chat, the same session continues. Then ${todo.length ? joinSteps(todo) : 'the task finishes'}.` };
    }
    case 'blocked':
      return {
        now:
          task.stateReason === 'loop_exhausted'
            ? `${step} didn’t succeed${attempt} and the workflow’s retry limit is used up, so the task stopped and came to you.`
            : task.stateReason === 'lost'
              ? `Nothing holds this task any more, which is a fault in Orstra. Re-run ${step} to pick it up again.`
              : `${reasonText(task.stateReason)}. The task stopped at ${step}${attempt}.`,
        next: 'Nothing happens until you re-run the step or stop the task.',
      };
    case 'done':
      return { now: 'Done. Every step finished.', next: 'Nothing.' };
    case 'stopped':
      return { now: 'Stopped. Nothing else will run for this task. Its worktree and sessions are kept.', next: 'Nothing.' };
  }
}
