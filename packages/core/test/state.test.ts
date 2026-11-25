import { describe, expect, it } from 'vitest';
import { deriveState, storedStatus, type OpenRunFacts, type StateInput, type TaskState } from '../src/index.ts';

const open = (p: Partial<OpenRunFacts> = {}): OpenRunFacts =>
  ({ id: 'r1', stepId: 'work', kind: 'agent', status: 'running', waitReason: null, lastTurnAt: null, live: true, ...p });
const input = (p: Partial<StateInput> = {}): StateInput => ({ stoppedAt: null, hasRuns: true, ...p });

describe('deriveState with an open run', () => {
  it('reads a live agent run as working', () => expect(deriveState(input({ open: open() })).state).toBe('working'));

  it('reads a dead agent run as paused', () => {
    const d = deriveState(input({ open: open({ live: false, lastTurnAt: 1000 }) }));
    expect(d).toMatchObject({ state: 'paused', lastTurnAt: 1000, stepId: 'work', runId: 'r1' });
  });

  it('reads a live waiting agent run as waiting_you with its reason', () =>
    expect(deriveState(input({ open: open({ status: 'waiting', waitReason: 'question', live: true }) }))).toMatchObject({
      state: 'waiting_you',
      reason: 'question',
    }));

  it('reads a dead waiting agent run as paused', () =>
    expect(deriveState(input({ open: open({ status: 'waiting', waitReason: 'question', live: false }) })).state).toBe('paused'));

  it('reads a waiting human run as decision', () =>
    expect(deriveState(input({ open: open({ kind: 'human', status: 'waiting', live: false }) })).state).toBe('decision'));

  it('reads a waiting wait or workflow run as sleeping, which is no Inbox state', () => {
    expect(deriveState(input({ open: open({ kind: 'wait', status: 'waiting', live: false }) })).state).toBe('sleeping');
    expect(deriveState(input({ open: open({ kind: 'workflow', status: 'waiting', live: false }) })).state).toBe('sleeping');
    expect(storedStatus('sleeping')).toBe('running');
  });

  it('reads a running gate run as checks', () =>
    expect(deriveState(input({ open: open({ kind: 'gate', live: false }) })).state).toBe('checks'));

  it('reads a running action run as working, with no session', () =>
    expect(deriveState(input({ open: open({ kind: 'action', live: false }) })).state).toBe('working'));

  it('reads any queued run as queued', () => {
    for (const kind of ['agent', 'gate', 'human', 'action', 'switch'])
      expect(deriveState(input({ open: open({ kind, status: 'queued', live: false }) })).state).toBe('queued');
  });

  // Review Focus 5: a pair the matrix does not name must still have an answer.
  it('names a state for a pair the matrix does not cover', () =>
    expect(deriveState(input({ open: open({ kind: 'gate', status: 'waiting', live: false }) })).state).toBe('decision'));
});

describe('deriveState with no open run', () => {
  it('reads a stopped task as stopped, over everything else', () =>
    expect(deriveState(input({ stoppedAt: 5, open: open() })).state).toBe('stopped'));

  it('reads end as done', () => expect(deriveState(input({ lastRouted: 'end', lastStepId: 'done' })).state).toBe('done'));

  it('reads a block as blocked, with its reason', () =>
    expect(deriveState(input({ lastRouted: 'block:conflict', lastStepId: 'merge' }))).toMatchObject({
      state: 'blocked',
      reason: 'conflict',
      stepId: 'merge',
    }));

  it('reads a goto with no open run as lost, which is a bug signal', () =>
    expect(deriveState(input({ lastRouted: 'goto:work' }))).toMatchObject({ state: 'blocked', reason: 'lost' }));

  // Review Focus 2: a task between insertTask and its first run must not read as a bug.
  it('reads a task with no runs yet as queued', () => expect(deriveState(input({ hasRuns: false })).state).toBe('queued'));

  it('reads a task that has runs but no routed run as lost', () =>
    expect(deriveState(input({ lastRouted: null }))).toMatchObject({ state: 'blocked', reason: 'lost' }));
});

describe('storedStatus', () => {
  it('keeps the Inbox membership of today', () => {
    expect((['queued', 'working', 'checks'] as TaskState[]).map(storedStatus)).toEqual(['running', 'running', 'running']);
    expect((['waiting_you', 'paused', 'decision', 'blocked'] as TaskState[]).map(storedStatus)).toEqual([
      'needs_you',
      'needs_you',
      'needs_you',
      'needs_you',
    ]);
    expect(storedStatus('done')).toBe('done');
    expect(storedStatus('stopped')).toBe('stopped');
  });
});
