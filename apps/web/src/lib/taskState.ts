import type { TaskState, TaskSummary } from '../api';
import { AGENTS } from './format';

export type { TaskState };

/**
 * Where a task stands. The daemon works this out from the task's runs and sends it, so the board,
 * the Inbox and the task page cannot disagree with the run list or with each other.
 */
export function taskState(t: Pick<TaskSummary, 'state'>): TaskState {
  // A page older than the daemon would otherwise throw on every screen.
  return Object.hasOwn(STATE, t.state) ? t.state : 'blocked';
}

export type StateGroup = 'needs' | 'running' | 'queued' | 'done';

export const STATE: Record<TaskState, { label: string; short: string; bg: string; fg: string; group: StateGroup }> = {
  working: { label: 'Running', short: 'Running', bg: 'var(--accent-soft)', fg: 'var(--accent-fg)', group: 'running' },
  checks: { label: 'Checks running', short: 'Checks', bg: 'var(--accent-soft)', fg: 'var(--accent-fg)', group: 'running' },
  queued: { label: 'Queued', short: 'Queued', bg: 'var(--line-3)', fg: 'var(--grey-fg)', group: 'queued' },
  decision: { label: 'Needs your decision', short: 'Decide', bg: 'var(--purple-soft)', fg: 'var(--purple-fg)', group: 'needs' },
  waiting_you: { label: 'Agent is waiting for you', short: 'Waiting for you', bg: 'var(--accent-soft)', fg: 'var(--accent-fg)', group: 'needs' },
  paused: { label: 'Paused', short: 'Paused', bg: 'var(--orange-soft)', fg: 'var(--orange-fg)', group: 'needs' },
  blocked: { label: 'Stuck', short: 'Stuck', bg: 'var(--red-soft)', fg: 'var(--red-fg)', group: 'needs' },
  done: { label: 'Done', short: 'Done', bg: 'var(--green-soft)', fg: 'var(--green-fg)', group: 'done' },
  stopped: { label: 'Stopped', short: 'Stopped', bg: 'var(--line-3)', fg: 'var(--grey-fg)', group: 'done' },
};

export const agentMeta = (t: Pick<TaskSummary, 'agent'>) => AGENTS[t.agent ?? 'claude-code'];

/** "Implement · attempt 2" for the step a task is at. */
export function stepLabel(t: Pick<TaskSummary, 'currentStepTitle' | 'run' | 'status'>): string {
  if (!t.currentStepTitle) return t.status === 'done' ? 'Finished' : '—';
  return t.currentStepTitle + (t.run && t.run.attempt > 1 ? ` · attempt ${t.run.attempt}` : '');
}
