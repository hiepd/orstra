import type { TaskSummary } from '../api';
import { AGENTS } from './format';

/** Where a task stands, as the UI names it. One word per situation, used on every screen. */
export type TaskState = 'running' | 'queued' | 'decision' | 'question' | 'stuck' | 'done' | 'stopped';

const WAITING_ON_REPLY = new Set(['question', 'reply', 'paused', 'restarted', 'no_outcome', 'permission']);

export function taskState(t: Pick<TaskSummary, 'status' | 'inboxReason' | 'run'>): TaskState {
  if (t.status === 'done') return 'done';
  if (t.status === 'stopped') return 'stopped';
  if (t.status === 'needs_you') {
    if (t.inboxReason === 'decision') return 'decision';
    return WAITING_ON_REPLY.has(t.inboxReason ?? '') ? 'question' : 'stuck';
  }
  return t.run?.status === 'queued' ? 'queued' : 'running';
}

export type StateGroup = 'needs' | 'running' | 'queued' | 'done';

export const STATE: Record<TaskState, { label: string; short: string; bg: string; fg: string; group: StateGroup }> = {
  running: { label: 'Running', short: 'Running', bg: 'var(--accent-soft)', fg: 'var(--accent-fg)', group: 'running' },
  queued: { label: 'Queued', short: 'Queued', bg: 'var(--line-3)', fg: 'var(--grey-fg)', group: 'queued' },
  decision: { label: 'Needs your decision', short: 'Decide', bg: 'var(--purple-soft)', fg: 'var(--purple-fg)', group: 'needs' },
  question: { label: 'Agent is waiting for you', short: 'Waiting for you', bg: 'var(--accent-soft)', fg: 'var(--accent-fg)', group: 'needs' },
  stuck: { label: 'Stuck', short: 'Stuck', bg: 'var(--red-soft)', fg: 'var(--red-fg)', group: 'needs' },
  done: { label: 'Done', short: 'Done', bg: 'var(--green-soft)', fg: 'var(--green-fg)', group: 'done' },
  stopped: { label: 'Stopped', short: 'Stopped', bg: 'var(--line-3)', fg: 'var(--grey-fg)', group: 'done' },
};

export const agentMeta = (t: Pick<TaskSummary, 'agent'>) => AGENTS[t.agent ?? 'claude-code'];

/** "Implement · attempt 2" for the step a task is at. */
export function stepLabel(t: Pick<TaskSummary, 'currentStepTitle' | 'run' | 'status'>): string {
  if (!t.currentStepTitle) return t.status === 'done' ? 'Finished' : '—';
  return t.currentStepTitle + (t.run && t.run.attempt > 1 ? ` · attempt ${t.run.attempt}` : '');
}
