import { END, SUCCESS_OUTCOME, type Workflow } from './workflow.ts';

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
  // A step that `when:` skipped follows its `skipped` arrow, else the arrow `next:` stands for.
  if (!target && outcome === 'skipped') {
    key = step.on[SUCCESS_OUTCOME[step.use]] ? SUCCESS_OUTCOME[step.use] : 'done';
    target = step.on[key];
  }
  if (!target) return { type: 'inbox', reason: outcome };
  if (target.goto === END) return { type: 'end' };

  const edge = `${stepId}:${key}`;
  if (target.max !== undefined && (edgeCounts[edge] ?? 0) >= target.max) {
    return { type: 'inbox', reason: 'loop_exhausted' };
  }
  return { type: 'goto', step: target.goto, edge };
}

/**
 * The case a switch step takes for `value`. An exact match (case and outer spaces ignored) wins. Else a
 * case that is a whole word of the value wins, but only when exactly one case is: "unpassed" does not
 * match "pass", and a value that names two cases takes the default. No match also takes the default.
 */
export function switchCase(cases: string[], value: string): string {
  const v = value.trim().toLowerCase();
  const names = cases.filter((k) => k !== 'default');
  const exact = names.find((k) => k.toLowerCase() === v);
  if (exact) return exact;
  const esc = (k: string) => k.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const words = names.filter((k) => new RegExp(`(^|[^\\w])${esc(k)}($|[^\\w])`).test(v));
  return words.length === 1 ? words[0] : 'default';
}
