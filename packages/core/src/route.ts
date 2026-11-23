import { END, type Workflow } from './workflow.ts';

export type Route =
  | { type: 'goto'; step: string; edge: string }
  | { type: 'end' }
  | { type: 'inbox'; reason: string };

/**
 * Where a task goes after `stepId` finished with `outcome`.
 * `edgeCounts` holds how often each arrow ("step:outcome") was already followed for this task.
 * Unmatched outcomes and exhausted loops go to the inbox; nothing is silently stuck.
 */
export function route(wf: Workflow, stepId: string, outcome: string, edgeCounts: Record<string, number>): Route {
  const step = wf.steps[stepId];
  if (!step) return { type: 'inbox', reason: 'unknown_step' };

  let key = outcome;
  let target = step.on[outcome];
  if (!target && step.use === 'switch' && step.on.default) {
    key = 'default';
    target = step.on.default;
  }
  if (!target) return { type: 'inbox', reason: outcome };
  if (target.goto === END) return { type: 'end' };

  const edge = `${stepId}:${key}`;
  if (target.max !== undefined && (edgeCounts[edge] ?? 0) >= target.max) {
    return { type: 'inbox', reason: 'loop_exhausted' };
  }
  return { type: 'goto', step: target.goto, edge };
}
