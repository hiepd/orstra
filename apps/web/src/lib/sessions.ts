import type { RunView, TaskDetail } from '../api';

/** A run's name: its step, plus the attempt (or round) when the step ran more than once. */
export const runName = (task: TaskDetail, r: RunView) => r.stepTitle + (r.attempt > 1 || task.runs.some((x) => x.stepId === r.stepId && x.id !== r.id) ? ` · ${r.kind === 'human' ? 'round' : 'attempt'} ${r.attempt}` : '');

/** Agent runs that have a session, newest first. One session per agent run. */
export const sessionsOf = (task: TaskDetail) => task.runs.filter((r) => r.kind === 'agent' && r.sessionId).reverse();

/** The session to show when none is picked: the one working or waiting on you, else the newest. */
export function defaultSession(task: TaskDetail): RunView | undefined {
  const all = sessionsOf(task);
  return all.find((r) => r.id === task.workingRunId) ?? all.find((r) => r.id === task.awaiting?.runId) ?? all[0];
}
