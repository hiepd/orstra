import type { WorkflowStep } from '../api';

export const END_ID = 'end';
export const COL_W = 270;
export const ROW_H = 132;

export const arrowKey = (from: string, outcome: string) => `${from}\u0000${outcome}`;

export interface LaidOut {
  positions: Map<string, { x: number; y: number }>;
  /** Arrows that point back to an earlier step (retry loops), as `arrowKey`s. */
  back: Set<string>;
}

/** Layer the steps left to right by their longest forward path from the start. Arrows that loop back don't affect layers. */
export function layoutWorkflow(steps: WorkflowStep[], start: string): LaidOut {
  const ids = steps.map((s) => s.id);
  const byId = new Map(steps.map((s) => [s.id, s]));
  const back = new Set<string>();

  // DFS from the start marks back edges (to a node still on the stack).
  const state = new Map<string, 1 | 2>();
  const visit = (id: string) => {
    state.set(id, 1);
    for (const o of byId.get(id)?.on ?? []) {
      if (o.to === END_ID || !byId.has(o.to)) continue;
      const s = state.get(o.to);
      if (s === 1) back.add(arrowKey(id, o.outcome));
      else if (!s) visit(o.to);
    }
    state.set(id, 2);
  };
  if (byId.has(start)) visit(start);
  for (const id of ids) if (!state.has(id)) visit(id);

  // Longest path over forward edges only (a DAG now), memoised.
  const incoming = new Map<string, string[]>(ids.map((i) => [i, []]));
  for (const s of steps) {
    for (const o of s.on) {
      if (o.to === END_ID || !byId.has(o.to) || back.has(arrowKey(s.id, o.outcome))) continue;
      incoming.get(o.to)!.push(s.id);
    }
  }
  const depth = new Map<string, number>();
  const depthOf = (id: string): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    const d = Math.max(-1, ...incoming.get(id)!.map(depthOf)) + 1;
    depth.set(id, d);
    return d;
  };
  for (const id of ids) depthOf(id);

  const layers = new Map<number, string[]>();
  for (const id of ids) {
    const d = depth.get(id)!;
    layers.set(d, [...(layers.get(d) ?? []), id]);
  }
  const maxDepth = Math.max(0, ...layers.keys());
  const tallest = Math.max(1, ...[...layers.values()].map((l) => l.length));

  const positions = new Map<string, { x: number; y: number }>();
  for (const [d, members] of layers) {
    const top = ((tallest - members.length) * ROW_H) / 2;
    members.forEach((id, i) => positions.set(id, { x: d * COL_W, y: top + i * ROW_H }));
  }
  positions.set(END_ID, { x: (maxDepth + 1) * COL_W, y: ((tallest - 1) * ROW_H) / 2 });
  return { positions, back };
}
