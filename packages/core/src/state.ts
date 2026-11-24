/**
 * Where a task stands, worked out from its runs. 1 definition, used by the daemon's projector, by
 * the API and by every screen, so no 2 of them can disagree.
 *
 * The inputs are facts that were written down. Whether a session is alive is the 1 exception: it is
 * known only inside the process that owns the session, and it is never stored, because a stored
 * "running" survives the death of the process that wrote it.
 */
export type TaskState = 'queued' | 'working' | 'checks' | 'waiting_you' | 'paused' | 'decision' | 'blocked' | 'done' | 'stopped';

/** The 4 values the task row keeps, for the queries that need SQL. */
export type StoredStatus = 'running' | 'needs_you' | 'done' | 'stopped';

/** The task's 1 open run: queued, running or waiting. */
export interface OpenRunFacts {
  id: string;
  stepId: string;
  kind: string;
  status: 'queued' | 'running' | 'waiting';
  /** Why an agent run waits on you: question, reply or paused. */
  waitReason: string | null;
  lastTurnAt: number | null;
  /** Its session is open in this process. Never read from disk. */
  live: boolean;
}

export interface StateInput {
  stoppedAt: number | null;
  /** false only between the moment a task is made and the moment its first step is queued. */
  hasRuns: boolean;
  open?: OpenRunFacts;
  /** `end`, `block:<reason>` or `goto:<stepId>`, from the newest ended run. */
  lastRouted?: string | null;
  lastStepId?: string | null;
}

export interface DerivedState {
  state: TaskState;
  stepId: string | null;
  /** The wait reason, or the block reason. Null when neither applies. */
  reason: string | null;
  runId: string | null;
  lastTurnAt: number | null;
}

/** An open agent run reads as paused when nothing is running it, whatever its row says. */
function openState(open: OpenRunFacts): TaskState {
  if (open.status === 'queued') return 'queued';
  if (open.status === 'waiting') {
    if (open.kind === 'agent') return open.live ? 'waiting_you' : 'paused';
    return 'decision';
  }
  if (open.kind === 'agent') return open.live ? 'working' : 'paused';
  return open.kind === 'gate' ? 'checks' : 'working';
}

export function deriveState(input: StateInput): DerivedState {
  const { open } = input;
  const at = (state: TaskState, reason: string | null = null): DerivedState => ({
    state,
    stepId: open?.stepId ?? input.lastStepId ?? null,
    reason,
    runId: open?.id ?? null,
    lastTurnAt: open?.lastTurnAt ?? null,
  });

  if (input.stoppedAt) return at('stopped');
  if (open) {
    const state = openState(open);
    return at(state, state === 'waiting_you' ? open.waitReason : null);
  }
  if (input.lastRouted === 'end') return at('done');
  if (input.lastRouted?.startsWith('block:')) return at('blocked', input.lastRouted.slice('block:'.length));
  // Nothing holds the task and it did not finish: a run was lost. Say so instead of a comfortable lie.
  if (input.hasRuns) return at('blocked', 'lost');
  return at('queued');
}

const NEEDS_YOU = new Set<TaskState>(['waiting_you', 'paused', 'decision', 'blocked']);

export function storedStatus(state: TaskState): StoredStatus {
  if (state === 'done' || state === 'stopped') return state;
  return NEEDS_YOU.has(state) ? 'needs_you' : 'running';
}
