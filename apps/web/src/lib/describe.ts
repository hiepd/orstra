import type { RunView, TaskDetail } from '../api';
import { AGENTS, reasonText } from './format';
import { taskState } from './taskState';

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
    case 'running':
      return {
        now: run?.kind === 'gate' ? `${step} is running${attempt}: its checks are in progress.` : run?.kind === 'agent' ? `${step} is running${attempt}. ${agent} is working on it.` : `${step} is running${attempt}.`,
        next: `${after}.`,
      };
    case 'queued':
      return { now: `${step} is queued${attempt}. It starts on its own when a slot is free.`, next: todo.length ? `${joinSteps(todo)}.` : 'Nothing after it.' };
    case 'decision':
      return { now: `Waiting for your decision at ${step}.`, next: 'Depends on what you choose.' };
    case 'question': {
      const r = task.inboxReason;
      const now =
        r === 'question'
          ? `${agent} asked a question during ${step}${attempt} and is waiting for your answer.`
          : r === 'reply'
            ? `${agent} answered you during ${step}${attempt} and is waiting for your reply.`
            : r === 'paused'
              ? `You stopped ${agent} during ${step}${attempt}. It is waiting for you to say what to do next.`
              : `Orstra restarted while ${step} was running. Message ${agent} in Chat to pick the session back up, or re-run the step.`;
      return { now, next: `When you reply in Chat, the same session continues. Then ${todo.length ? joinSteps(todo) : 'the task finishes'}.` };
    }
    case 'stuck':
      return {
        now:
          task.inboxReason === 'loop_exhausted'
            ? `${step} didn’t succeed${attempt} and the workflow’s retry limit is used up, so the task stopped and came to you.`
            : `${reasonText(task.inboxReason)}. The task stopped at ${step}${attempt}.`,
        next: 'Nothing happens until you re-run the step or stop the task.',
      };
    case 'done':
      return { now: 'Done. Every step finished.', next: 'Nothing.' };
    case 'stopped':
      return { now: 'Stopped. Nothing else will run for this task. Its worktree and sessions are kept.', next: 'Nothing.' };
  }
}
