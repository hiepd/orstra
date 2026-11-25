import type { StepKind } from '../api';

export const KIND: Record<StepKind, { label: string; bg: string; fg: string }> = {
  agent: { label: 'Agent', bg: 'var(--accent-soft)', fg: 'var(--accent-fg)' },
  gate: { label: 'Checks', bg: 'var(--green-soft)', fg: 'var(--green-fg)' },
  human: { label: 'Your decision', bg: 'var(--purple-soft)', fg: 'var(--purple-fg)' },
  switch: { label: 'Branch', bg: 'var(--line-3)', fg: 'var(--grey-fg)' },
  action: { label: 'Action', bg: 'var(--orange-soft)', fg: 'var(--orange-fg)' },
  workflow: { label: 'Workflow', bg: 'var(--line-3)', fg: 'var(--grey-fg)' },
  wait: { label: 'Wait', bg: 'var(--line-3)', fg: 'var(--grey-fg)' },
};
