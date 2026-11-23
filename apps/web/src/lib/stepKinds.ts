import type { StepKind } from '../api';

export const KIND: Record<StepKind, { label: string; bg: string; fg: string }> = {
  agent: { label: 'Agent', bg: '#EEF0FB', fg: '#4B55B8' },
  gate: { label: 'Checks', bg: '#EAF6EF', fg: '#1A7F4B' },
  human: { label: 'Your decision', bg: '#F3EEFC', fg: '#7444C2' },
  switch: { label: 'Branch', bg: '#F0F1F4', fg: '#5A5A63' },
  action: { label: 'Action', bg: '#FDF0E8', fg: '#B4531B' },
  workflow: { label: 'Workflow', bg: '#F0F1F4', fg: '#5A5A63' },
};
