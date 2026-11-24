/**
 * The side viewer's state: 1 or 2 panes, each with its tabs, the pane you used last, the layout of a
 * split, and whether the viewer shows or covers the chat. Pure, so the rules have tests.
 *
 * A TabId is a panel ("changes", "files", "browser", "terminal", "side", "artifacts"), a worktree file
 * ("file:<path>") or a URL ("link:<url>").
 */

export type TabId = string;
export type Pane = { tabs: TabId[]; active: TabId | null };
export type SplitDir = 'row' | 'column';
export type ViewerState = {
  panes: Pane[];
  focus: number;
  dir: SplitDir;
  expanded: boolean;
  open: boolean;
  /** The viewer's width in px, when you dragged its edge. None: half the window. */
  width?: number;
  /** The first pane's share of a split, 0.2 to 0.8. None: half each. */
  ratio?: number;
};

/** The narrowest viewer a drag gives. The chat keeps its own 380 px in CSS. */
export const MIN_VIEWER_WIDTH = 320;

export type ViewerAction =
  | { type: 'open'; tab: TabId }
  | { type: 'pick'; pane: number; tab: TabId }
  | { type: 'close'; pane: number; tab: TabId }
  | { type: 'closeOthers'; pane: number; tab: TabId }
  | { type: 'split'; pane: number; tab: TabId; dir: SplitDir }
  | { type: 'move'; pane: number; tab: TabId }
  | { type: 'unsplit' }
  | { type: 'setDir'; dir: SplitDir }
  | { type: 'toggleExpand' }
  | { type: 'toggleOpen' }
  /** null resets to the default size. */
  | { type: 'resize'; width: number | null }
  | { type: 'ratio'; ratio: number | null };

/** Closed at first: the chat gets the room until a reference, a shortcut or the toggle opens it. */
export const initialViewer = (): ViewerState => ({ panes: [{ tabs: ['changes'], active: 'changes' }], focus: 0, dir: 'row', expanded: false, open: false });

/** A pane without one tab. The active tab, when it goes, passes to its right neighbour, else its left. */
function without(p: Pane, tab: TabId): Pane {
  const i = p.tabs.indexOf(tab);
  if (i < 0) return p;
  const tabs = p.tabs.filter((t) => t !== tab);
  return { tabs, active: p.active === tab ? tabs[i] ?? tabs[i - 1] ?? null : p.active };
}

/** Drop a pane left empty, when another pane is there. */
function tidy(s: ViewerState, focus: number): ViewerState {
  if (s.panes.length > 1) {
    const empty = s.panes.findIndex((p) => !p.tabs.length);
    if (empty >= 0) return { ...s, panes: s.panes.filter((_, i) => i !== empty), focus: 0 };
  }
  return { ...s, focus: Math.min(focus, s.panes.length - 1) };
}

export function reduce(s: ViewerState, a: ViewerAction): ViewerState {
  const panes = s.panes.map((p) => ({ ...p, tabs: [...p.tabs] }));
  switch (a.type) {
    case 'open': {
      const at = panes.findIndex((p) => p.tabs.includes(a.tab));
      if (at >= 0) {
        panes[at].active = a.tab;
        return { ...s, panes, focus: at, open: true };
      }
      const f = Math.min(s.focus, panes.length - 1);
      panes[f] = { tabs: [...panes[f].tabs, a.tab], active: a.tab };
      return { ...s, panes, focus: f, open: true };
    }
    case 'pick':
      if (!panes[a.pane]?.tabs.includes(a.tab)) return s;
      panes[a.pane].active = a.tab;
      return { ...s, panes, focus: a.pane };
    case 'close':
      if (!panes[a.pane]) return s;
      panes[a.pane] = without(panes[a.pane], a.tab);
      return tidy({ ...s, panes }, a.pane);
    case 'closeOthers':
      if (!panes[a.pane]) return s;
      panes[a.pane] = { tabs: [a.tab], active: a.tab };
      return { ...s, panes, focus: a.pane };
    case 'split': {
      if (panes.length > 1 || !panes[a.pane]) return s;
      // A lone tab shows in both panes; otherwise the tab moves to the new one.
      if (panes[a.pane].tabs.length > 1) panes[a.pane] = without(panes[a.pane], a.tab);
      return { ...s, panes: [...panes, { tabs: [a.tab], active: a.tab }], focus: 1, dir: a.dir, open: true };
    }
    case 'move': {
      const to = 1 - a.pane;
      if (panes.length < 2 || !panes[a.pane]?.tabs.includes(a.tab)) return s;
      panes[a.pane] = without(panes[a.pane], a.tab);
      panes[to] = { tabs: panes[to].tabs.includes(a.tab) ? panes[to].tabs : [...panes[to].tabs, a.tab], active: a.tab };
      const next = tidy({ ...s, panes }, to);
      return next.panes.length < panes.length ? { ...next, focus: 0 } : next;
    }
    case 'unsplit': {
      if (panes.length < 2) return s;
      const tabs = [...panes[0].tabs, ...panes[1].tabs.filter((t) => !panes[0].tabs.includes(t))];
      const active = panes[s.focus]?.active ?? panes[0].active ?? panes[1].active;
      return { ...s, panes: [{ tabs, active }], focus: 0 };
    }
    case 'setDir':
      return { ...s, dir: a.dir };
    case 'toggleExpand':
      return { ...s, expanded: !s.expanded || !s.open, open: true };
    case 'toggleOpen':
      return { ...s, open: !s.open, expanded: false };
    case 'resize': {
      const { width: _w, ...rest } = s;
      return a.width === null ? rest : { ...s, width: Math.max(MIN_VIEWER_WIDTH, Math.round(a.width)) };
    }
    case 'ratio': {
      const { ratio: _r, ...rest } = s;
      return a.ratio === null ? rest : { ...s, ratio: Math.min(0.8, Math.max(0.2, a.ratio)) };
    }
  }
}
