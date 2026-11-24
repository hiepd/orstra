import { deriveState, storedStatus, type DerivedState, type StateInput, type TaskState } from '@orstra/core';
import type { RunRow, Store, TaskRow } from './db.ts';

/**
 * The 1 writer of a task's state. Every screen reads `status`, `current_step` and `inbox_reason`,
 * and nothing but this file may write them, so the board and the run list cannot disagree.
 *
 * The state itself is derived, never authored: give it the same runs and it gives the same answer,
 * which is what `rebuildAll` relies on.
 */
export type IsLive = (runId: string) => boolean;

const OPEN = new Set(['queued', 'running', 'waiting']);
const ENDED = new Set(['done', 'failed']);

/** The facts about a task, as `deriveState` wants them. Pass `runs` when you already loaded them. */
export function taskFacts(store: Store, isLive: IsLive, task: TaskRow, runs?: RunRow[]): StateInput {
  const all = runs ?? store.runsForTask(task.id);
  const open = all.find((r) => OPEN.has(r.status));
  const ended = [...all].reverse().find((r) => ENDED.has(r.status) && r.outcome);
  return {
    stoppedAt: task.stopped_at,
    hasRuns: all.length > 0,
    open: open && {
      id: open.id, stepId: open.step_id, kind: open.kind, status: open.status as 'queued' | 'running' | 'waiting',
      waitReason: open.wait_reason, lastTurnAt: open.last_turn_at, live: isLive(open.id),
    },
    lastRouted: ended?.routed ?? null,
    // A task you stopped kept its step before this change, and a re-run needs it. The newest run
    // holds it even when that run was closed by the stop and so routed nowhere.
    lastStepId: (ended ?? all.at(-1))?.step_id ?? null,
  };
}

/** The old inbox_reason, which is the state and its reason folded into 1 word. */
function inboxReason(d: DerivedState): string | null {
  if (d.state === 'waiting_you') return d.reason ?? 'reply';
  if (d.state === 'paused' || d.state === 'decision') return d.state;
  if (d.state === 'blocked') return d.reason;
  return null;
}

export function projectTask(store: Store, isLive: IsLive, taskId: string): DerivedState | undefined {
  const task = store.task(taskId);
  if (!task) return undefined;
  const d = deriveState(taskFacts(store, isLive, task));
  const status = storedStatus(d.state);
  const inbox = inboxReason(d);
  // Write only a change: a projection that touched every row would make every task look just updated.
  if (task.status !== status || task.current_step !== d.stepId || task.inbox_reason !== inbox) {
    store.updateTask(taskId, { status, current_step: d.stepId, inbox_reason: inbox });
  }
  return d;
}

/** Redo the projection for every task. Returns the ones whose stored status moved. */
export function rebuildAll(store: Store, isLive: IsLive): { taskId: string; from: string; to: string }[] {
  const changed: { taskId: string; from: string; to: string }[] = [];
  for (const t of store.tasks()) {
    const before = t.status;
    const d = projectTask(store, isLive, t.id);
    const after = d ? storedStatus(d.state as TaskState) : before;
    if (after !== before) changed.push({ taskId: t.id, from: before, to: after });
  }
  return changed;
}
