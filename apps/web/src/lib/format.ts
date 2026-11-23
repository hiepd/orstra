import type { AgentName, RunView, TaskSummary } from '../api';

export const taskLabel = (t: Pick<TaskSummary, 'id' | 'ref'>) => t.ref || t.id.slice(0, 8);

export const AGENTS: Record<AgentName | 'gate', { av: string; color: string; name: string }> = {
  'claude-code': { av: 'C', color: '#C15F3C', name: 'Claude Code' },
  codex: { av: 'X', color: 'var(--ink)', name: 'Codex' },
  gate: { av: 'G', color: '#4CB782', name: 'Gate' },
};

export function agentOf(run: Pick<RunView, 'kind' | 'agent'>) {
  if (run.kind === 'gate') return AGENTS.gate;
  return AGENTS[run.agent ?? 'claude-code'];
}

const REASONS: Record<string, string> = {
  decision: 'Waiting for your decision',
  question: 'Claude Code is asking you something',
  reply: 'Claude Code replied',
  paused: 'You stopped Claude Code',
  restarted: 'Orstra restarted mid-run',
  needs_you: 'Needs you: the agent asked for help',
  cant_do: 'The agent couldn’t do it',
  loop_exhausted: 'Retries used up',
  conflict: 'The merge conflicts; nothing was merged',
  error: 'The step couldn’t finish',
  missing_artifact: 'The step produced no artifact it must produce',
  interrupted: 'Orstra restarted mid-run',
  timeout: 'The step timed out',
  fail: 'The step failed with nowhere to go',
  unknown_step: 'The workflow points at a step that doesn’t exist',
  no_outcome: 'The agent ended without an outcome',
  over_budget: 'The task reached its budget',
  permission: 'An agent asks for permission',
  refused: 'The cleanup was refused; nothing changed',
  nothing: 'There was nothing to do',
};

/** "$0.42", or "<$0.01" for a cost above zero that rounds to nothing. */
export function money(usd: number | null | undefined): string {
  if (!usd) return '$0.00';
  return usd < 0.01 ? '<$0.01' : `$${usd.toFixed(2)}`;
}

/** "12.4k tokens" */
export function tokens(n: number | null | undefined): string {
  const v = n ?? 0;
  return v >= 1_000_000 ? `${(v / 1_000_000).toFixed(1)}M` : v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v);
}

export function reasonText(reason: string | null | undefined): string {
  if (!reason) return 'Needs you';
  return REASONS[reason] ?? `Needs you: no path for “${reason.replace(/_/g, ' ')}”`;
}

export const TASK_STATUS_LABEL: Record<TaskSummary['status'], string> = {
  needs_you: 'Needs you',
  running: 'Running',
  done: 'Done',
  stopped: 'Stopped',
};

export function humanize(s: string): string {
  const t = s.replace(/_/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
}
