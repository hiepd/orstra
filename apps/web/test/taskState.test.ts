import { describe, expect, it } from 'vitest';
import type { TaskDetail, TaskSummary } from '../src/api';
import { awaitingTitle, describeTask } from '../src/lib/describe';
import { STATE, stepLabel, taskState, type TaskState } from '../src/lib/taskState';

const ALL: TaskState[] = ['queued', 'working', 'checks', 'sleeping', 'waiting_you', 'paused', 'decision', 'blocked', 'done', 'stopped'];
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

  it('says you stopped it when you interrupted the turn', () => {
    const stopped = { ...task, state: 'waiting_you', stateReason: 'paused' } as unknown as TaskDetail;
    expect(describeTask(stopped).now).toContain('You stopped');
  });

  it('tells a session you stopped apart from one that died with the daemon', () => {
    expect(awaitingTitle('waiting_you', 'paused')).toBe('You stopped Claude Code');
    expect(awaitingTitle('paused', null)).toBe('Claude Code’s session is closed');
    expect(awaitingTitle('waiting_you', 'question')).toBe('Claude Code is asking');
    expect(awaitingTitle('waiting_you', 'reply')).toBe('Claude Code replied');
    expect(awaitingTitle('waiting_you', 'permission')).toBe('Claude Code needs your OK');
    expect(awaitingTitle('waiting_you', 'no_outcome')).toBe('Claude Code ended without an outcome');
  });

  it('says the session is closed when the run is paused', () => {
    const paused = { ...task, state: 'paused', lastTurnAt: Date.now() - 1000 } as unknown as TaskDetail;
    expect(describeTask(paused).now).toContain('session');
  });
});

describe('describeTask for the new waits', () => {
  const base = (state: string, run: Record<string, unknown>) =>
    ({
      state, stateReason: null, status: 'running', inboxReason: null, currentStep: 's', currentStepTitle: 'Build', agent: 'claude-code',
      run: { status: run.status, attempt: 2, kind: run.kind }, runs: [{ id: 'r', stepId: 's', stepTitle: 'Build', attempt: 2, ...run }],
      workingRunId: null, awaiting: null, human: null, track: [{ id: 's', title: 'Build', kind: run.kind, state: 'current' }],
    }) as unknown as TaskDetail;

  it('says when a retry after a fault starts', () => {
    const now = describeTask(base('queued', { kind: 'agent', status: 'queued', notBefore: Date.now() + 60_000, retries: 1 })).now;
    expect(now).toContain('Orstra retries it at');
    expect(now).toContain('(retry 1)');
  });

  it('says a callback wait waits for an outside system, and a timer until when', () => {
    expect(describeTask(base('sleeping', { kind: 'wait', status: 'waiting', callbackUrl: 'http://127.0.0.1:4317/api/callbacks/x' })).now).toBe('Build waits for an outside system to call back.');
    expect(describeTask(base('sleeping', { kind: 'wait', status: 'waiting', wakeAt: Date.now() + 3_600_000 })).now).toMatch(/^Build waits until /);
    expect(describeTask(base('sleeping', { kind: 'workflow', status: 'waiting' })).now).toBe('Build waits for the tasks it started.');
  });
});
