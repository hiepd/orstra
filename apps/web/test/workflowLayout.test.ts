import { describe, expect, it } from 'vitest';
import { arrowKey, END_ID, layoutWorkflow, NODE_H, NODE_W, type LayoutStep } from '../src/lib/workflowLayout';

const step = (id: string, ...on: [string, string, number?][]): LayoutStep => ({ id, on: on.map(([outcome, to, max]) => ({ outcome, to, max: max ?? null })) });

// The shape of linear-to-pr: a switch that branches, arrows that skip steps (approve -> end), and retry loops back.
const linearToPr = [
  step('route', ['bug', 'repro'], ['default', 'spec']),
  step('repro', ['done', 'impl']),
  step('spec', ['done', 'approve']),
  step('approve', ['approved', 'impl'], ['changes_requested', 'spec', 3], ['rejected', END_ID]),
  step('impl', ['done', 'verify']),
  step('verify', ['pass', 'review'], ['fail', 'impl', 3]),
  step('review', ['done', END_ID]),
];

const overlap = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.abs(a.x - b.x) < NODE_W && Math.abs(a.y - b.y) < NODE_H;

describe('layoutWorkflow', () => {
  const out = layoutWorkflow(linearToPr, 'route');

  it('places every step and the end', () => {
    for (const s of linearToPr) expect(out.positions.has(s.id)).toBe(true);
    expect(out.positions.has(END_ID)).toBe(true);
  });

  it('never puts two steps on top of each other', () => {
    const ids = [...out.positions.keys()].filter((i) => i !== END_ID);
    for (const a of ids) for (const b of ids) if (a < b) expect(overlap(out.positions.get(a)!, out.positions.get(b)!), `${a} / ${b}`).toBe(false);
  });

  it('flows top to bottom along forward arrows', () => {
    for (const s of linearToPr)
      for (const o of s.on) {
        if (out.back.has(arrowKey(s.id, o.outcome))) continue;
        expect(out.positions.get(o.to)!.y, `${s.id} -> ${o.to}`).toBeGreaterThan(out.positions.get(s.id)!.y);
      }
  });

  it('treats retry arrows as loops, not as layers', () => {
    expect([...out.back].sort()).toEqual([arrowKey('approve', 'changes_requested'), arrowKey('verify', 'fail')].sort());
  });

  it('routes the arrow that skips a step around it', () => {
    const r = out.routes.get(arrowKey('approve', 'rejected'))!;
    expect(r.to).toBe(END_ID);
    // approve -> end jumps over the impl/verify/review layers, so its route has bends in between.
    expect(r.points.length).toBeGreaterThan(2);
    const sy = out.positions.get('approve')!.y + NODE_H;
    const ey = out.positions.get(END_ID)!.y;
    for (const p of r.points.slice(1, -1)) {
      expect(p.y).toBeGreaterThan(sy);
      expect(p.y).toBeLessThan(ey);
      for (const mid of ['impl', 'verify', 'review']) {
        const n = out.positions.get(mid)!;
        const inside = p.x > n.x && p.x < n.x + NODE_W && p.y > n.y && p.y < n.y + NODE_H;
        expect(inside, `bend inside ${mid}`).toBe(false);
      }
    }
  });

  it('copes with a lone step, a missing start, and arrows to unknown steps', () => {
    expect(layoutWorkflow([step('a')], 'a').positions.size).toBe(2);
    expect(layoutWorkflow([step('a', ['done', 'b']), step('b')], 'nope').positions.size).toBe(3);
    expect(layoutWorkflow([step('a', ['done', 'ghost'])], 'a').routes.size).toBe(0);
  });
});
