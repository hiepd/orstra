import { describe, expect, it } from 'vitest';
import type { TaskDetail, TaskSummary } from '../src/api';
import { describeTask } from '../src/lib/describe';
import { STATE, stepLabel, taskState, type TaskState } from '../src/lib/taskState';

const ALL: TaskState[] = ['queued', 'working', 'checks', 'waiting_you', 'paused', 'decision', 'blocked', 'done', 'stopped'];
const row = (state: string, p: Partial<TaskSummary> = {}) => ({ state, stateReason: null, ...p }) as TaskSummary;

describe('taskState on the board', () => {
  it('returns the state the daemon computed', () => {
    expect(taskState(row('paused'))).toBe('paused');
    expect(taskState(row('decision'))).toBe('decision');
  });

  it('has a label, a colour and a group for every state', () => {
    for (const s of ALL) expect(STATE[s]).toMatchObject({ label: expect.any(String), short: expect.any(String), group: expect.any(String) });
  });

  // Review Focus 3: an older page against a newer daemon must not throw on every screen.
  it('does not throw on a state it does not know', () => {
    const s = taskState(row('something_new'));
    expect(ALL).toContain(s);
    expect(() => STATE[s].label).not.toThrow();
  });

  it('reads a task that went back to the agent as running', () => {
    const back = row('working', { currentStepTitle: 'Work', run: { status: 'running', attempt: 2, kind: 'agent' } });
    expect(STATE[taskState(back)].label).toBe('Running');
    expect(STATE[taskState(back)].group).toBe('running');
    expect(stepLabel({ currentStepTitle: 'Work', status: 'running', run: back.run })).toBe('Work · attempt 2');
  });
});

/** The task page's own sentence, for the same state: the agent works, your decision is gone. */
describe('describeTask after a chat sent the task back', () => {
  const run = { id: 'r2', stepId: 'work', stepTitle: 'Work', kind: 'agent', attempt: 2, status: 'running', agent: 'claude-code', live: true };
  const task = {
    state: 'working', stateReason: null, status: 'running', inboxReason: null, currentStep: 'work', currentStepTitle: 'Work', agent: 'claude-code',
    run: { status: 'running', attempt: 2, kind: 'agent' }, runs: [run], workingRunId: 'r2', awaiting: null, human: null,
    track: [{ id: 'work', title: 'Work', kind: 'agent', state: 'current' }, { id: 'review', title: 'Review', kind: 'human', state: 'todo' }],
  } as unknown as TaskDetail;

  it('says the agent is working on the step again', () => {
    const { now, next } = describeTask(task);
    expect(now).toBe('Work is running (attempt 2). Claude Code is working on it.');
    expect(next).toBe('Review.');
  });

  it('says the session is closed when the run is paused', () => {
    const paused = { ...task, state: 'paused', lastTurnAt: Date.now() - 1000 } as unknown as TaskDetail;
    expect(describeTask(paused).now).toContain('session');
  });
});
