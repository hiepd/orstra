import { describe, expect, it } from 'vitest';
import type { TaskDetail } from '../src/api';
import { describeTask } from '../src/lib/describe';
import { STATE, stepLabel, taskState } from '../src/lib/taskState';

type Row = Parameters<typeof taskState>[0];

const row = (status: Row['status'], inboxReason: string | null, run: Row['run']): Row => ({ status, inboxReason, run });

describe('taskState on the board', () => {
  it('reads a task that waits on a decision as "Decide"', () => {
    const s = taskState(row('needs_you', 'decision', { status: 'waiting', attempt: 1, kind: 'human' }));
    expect(s).toBe('decision');
    expect(STATE[s].short).toBe('Decide');
  });

  // A chat during a human step sends the task back: the agent's new run holds the step again.
  it('reads a task that went back to the agent as running', () => {
    const back = row('running', null, { status: 'running', attempt: 2, kind: 'agent' });
    const s = taskState(back);
    expect(s).toBe('running');
    expect(STATE[s].label).toBe('Running');
    expect(STATE[s].group).toBe('running');
    expect(stepLabel({ currentStepTitle: 'Work', status: 'running', run: back.run })).toBe('Work · attempt 2');
  });
});

/** The task page's own sentence, for the same state: the agent works, your decision is gone. */
describe('describeTask after a chat sent the task back', () => {
  const run = { id: 'r2', stepId: 'work', stepTitle: 'Work', kind: 'agent', attempt: 2, status: 'running', agent: 'claude-code', live: true };
  const task = {
    status: 'running', inboxReason: null, currentStep: 'work', currentStepTitle: 'Work', agent: 'claude-code',
    run: { status: 'running', attempt: 2, kind: 'agent' }, runs: [run], workingRunId: 'r2', awaiting: null, human: null,
    track: [{ id: 'work', title: 'Work', kind: 'agent', state: 'current' }, { id: 'review', title: 'Review', kind: 'human', state: 'todo' }],
  } as unknown as TaskDetail;

  it('says the agent is working on the step again', () => {
    const { now, next } = describeTask(task);
    expect(now).toBe('Work is running (attempt 2). Claude Code is working on it.');
    expect(next).toBe('Review.');
  });
});
