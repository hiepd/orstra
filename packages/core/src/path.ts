import { END, SUCCESS_OUTCOME, type Workflow } from './workflow.ts';

/**
 * The steps to show for one task, in order: the ones it has been through, then the ones it will most
 * likely reach if every remaining step succeeds. Branches not taken are left out.
 */
export function taskPath(wf: Workflow, visited: string[], current: string | null): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (id: string) => {
    if (wf.steps[id] && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  };
  visited.forEach(add);
  let at: string | null = current ?? (visited.length ? null : wf.start);
  if (at) add(at);

  const walked = new Set<string>();
  while (at && wf.steps[at] && !walked.has(at)) {
    walked.add(at);
    const step = wf.steps[at];
    const target = step.on[SUCCESS_OUTCOME[step.use]] ?? (step.use === 'switch' ? Object.values(step.on)[0] : undefined);
    if (!target || target.goto === END) break;
    add(target.goto);
    at = target.goto;
  }
  return out;
}
