import dagre from '@dagrejs/dagre';
import { humanize } from './format';

export const END_ID = 'end';
/** Node boxes as drawn by the canvas (see `.wf-node` / `.wf-end`). Dagre needs them to leave the right gaps. */
export const NODE_W = 210;
export const NODE_H = 78;
export const END_W = 64;
export const END_H = 34;
/** React Flow reports a handle's position at its outer edge: half of the 6px dot sticks out of the node. */
const HANDLE = 3;

export const arrowKey = (from: string, outcome: string) => `${from}\u0000${outcome}`;

/** The part of a step the layout needs. */
export interface LayoutStep {
  id: string;
  on: { outcome: string; to: string; max: number | null }[];
}

export interface Pt {
  x: number;
  y: number;
}

/** A forward arrow's path: from the source's bottom handle, through the gaps between steps, to the target's top handle. */
export interface Route {
  to: string;
  points: Pt[];
  label: Pt;
}

export interface LaidOut {
  /** Top-left corner of every step, plus `end`. */
  positions: Map<string, Pt>;
  /** Arrows that point back to an earlier step (retry loops), as `arrowKey`s. They loop down the right-hand side instead of being routed. */
  back: Set<string>;
  /** Routes for the other arrows, as `arrowKey`s. */
  routes: Map<string, Route>;
}

export const edgeLabel = (o: { outcome: string; max: number | null }) =>
  o.max ? `${humanize(o.outcome).toLowerCase()} · at most ${o.max}×` : humanize(o.outcome).toLowerCase();

// Rough width of a 11px label, so dagre can leave room for it between two steps.
const labelSize = (text: string) => ({ width: Math.ceil(text.length * 6.2) + 12, height: 20 });

/**
 * Lay the steps out top to bottom with dagre. Arrows that loop back are left out of the layering (they only make
 * the layout tangle) and drawn as loops down the right-hand side. Arrows that skip steps get their own lane, so they go
 * around the steps in between instead of through them.
 */
export function layoutWorkflow(steps: LayoutStep[], start: string): LaidOut {
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

  const g = new dagre.graphlib.Graph({ multigraph: true });
  g.setGraph({ rankdir: 'TB', ranksep: 44, nodesep: 40, edgesep: 24, marginx: 0, marginy: 0, ranker: 'network-simplex' });
  g.setDefaultEdgeLabel(() => ({}));
  for (const id of ids) g.setNode(id, { width: NODE_W, height: NODE_H });
  g.setNode(END_ID, { width: END_W, height: END_H });
  // Keep the start step first in the input so that ties resolve towards it being on top.
  for (const s of steps) {
    for (const o of s.on) {
      const key = arrowKey(s.id, o.outcome);
      if (back.has(key) || (o.to !== END_ID && !byId.has(o.to))) continue;
      g.setEdge(s.id, o.to, { ...labelSize(edgeLabel(o)), labelpos: 'c', weight: 1 }, key);
    }
  }
  dagre.layout(g);

  const positions = new Map<string, Pt>();
  const centre = new Map<string, Pt>();
  for (const id of [...ids, END_ID]) {
    const n = g.node(id);
    const w = id === END_ID ? END_W : NODE_W;
    const h = id === END_ID ? END_H : NODE_H;
    centre.set(id, { x: n.x, y: n.y });
    positions.set(id, { x: Math.round(n.x - w / 2), y: Math.round(n.y - h / 2) });
  }

  const routes = new Map<string, Route>();
  for (const e of g.edges()) {
    const l = g.edge(e);
    const from = centre.get(e.v)!;
    const to = centre.get(e.w)!;
    const inner: Pt[] = (l.points ?? []).slice(1, -1);
    const start: Pt = { x: from.x, y: from.y + NODE_H / 2 + HANDLE };
    const end: Pt = { x: to.x, y: to.y - (e.w === END_ID ? END_H : NODE_H) / 2 - HANDLE };
    routes.set(e.name!, { to: e.w, points: [start, ...inner, end], label: { x: l.x ?? (start.x + end.x) / 2, y: l.y ?? (start.y + end.y) / 2 } });
  }
  return { positions, back, routes };
}

/** An S-curve through the points, leaving and entering each one vertically. */
export function routePath(points: Pt[]): string {
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const my = (a.y + b.y) / 2;
    d += ` C ${a.x} ${my}, ${b.x} ${my}, ${b.x} ${b.y}`;
  }
  return d;
}
