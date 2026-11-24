import { describe, expect, it } from 'vitest';
import { initialViewer, reduce, type ViewerState } from '../src/components/viewer/state';

const two = (): ViewerState => ({ ...initialViewer(), panes: [{ tabs: ['changes', 'file:a.md'], active: 'file:a.md' }], focus: 0 });

describe('viewer state', () => {
  it('starts with Changes, open', () => {
    expect(initialViewer()).toEqual({ panes: [{ tabs: ['changes'], active: 'changes' }], focus: 0, dir: 'row', expanded: false, open: true });
  });

  it('opens a new tab in the focused pane, and focuses a tab that is open', () => {
    let s = reduce(two(), { type: 'split', pane: 0, tab: 'file:a.md', dir: 'row' });
    s = reduce(s, { type: 'pick', pane: 0, tab: 'changes' });
    s = reduce(s, { type: 'open', tab: 'file:a.md' });
    expect(s.focus).toBe(1);
    expect(s.panes[1].active).toBe('file:a.md');
    s = reduce(s, { type: 'open', tab: 'terminal' });
    expect(s.panes[1].tabs).toEqual(['file:a.md', 'terminal']);
    expect(s.panes[1].active).toBe('terminal');
  });

  it('opens the viewer when a tab opens while it is hidden', () => {
    const s = reduce({ ...initialViewer(), open: false }, { type: 'open', tab: 'files' });
    expect(s.open).toBe(true);
  });

  it('splits down: the tab moves to a new pane, which gets the focus', () => {
    const s = reduce(two(), { type: 'split', pane: 0, tab: 'file:a.md', dir: 'column' });
    expect(s.panes).toEqual([{ tabs: ['changes'], active: 'changes' }, { tabs: ['file:a.md'], active: 'file:a.md' }]);
    expect(s.dir).toBe('column');
    expect(s.focus).toBe(1);
  });

  it('shows a lone tab in both panes when it splits', () => {
    const s = reduce(initialViewer(), { type: 'split', pane: 0, tab: 'changes', dir: 'row' });
    expect(s.panes.map((p) => p.tabs)).toEqual([['changes'], ['changes']]);
  });

  it('keeps 2 panes at most', () => {
    const s = reduce(two(), { type: 'split', pane: 0, tab: 'file:a.md', dir: 'row' });
    expect(reduce(s, { type: 'split', pane: 1, tab: 'file:a.md', dir: 'row' })).toBe(s);
  });

  it('moves a tab to the other pane, and drops a pane that is left empty', () => {
    let s = reduce(two(), { type: 'split', pane: 0, tab: 'file:a.md', dir: 'row' });
    s = reduce(s, { type: 'open', tab: 'files' });
    s = reduce(s, { type: 'move', pane: 1, tab: 'files' });
    expect(s.panes.map((p) => p.tabs)).toEqual([['changes', 'files'], ['file:a.md']]);
    expect(s.focus).toBe(0);
    s = reduce(s, { type: 'move', pane: 1, tab: 'file:a.md' });
    expect(s.panes).toEqual([{ tabs: ['changes', 'files', 'file:a.md'], active: 'file:a.md' }]);
  });

  it('closes the last tab of a pane, and the pane with it', () => {
    let s = reduce(two(), { type: 'split', pane: 0, tab: 'file:a.md', dir: 'row' });
    s = reduce(s, { type: 'close', pane: 1, tab: 'file:a.md' });
    expect(s.panes).toEqual([{ tabs: ['changes'], active: 'changes' }]);
    expect(s.focus).toBe(0);
  });

  it('closes a tab and makes its neighbour active', () => {
    const s = reduce({ ...initialViewer(), panes: [{ tabs: ['a', 'b', 'c'], active: 'b' }] }, { type: 'close', pane: 0, tab: 'b' });
    expect(s.panes[0]).toEqual({ tabs: ['a', 'c'], active: 'c' });
  });

  it('closes the other tabs', () => {
    const s = reduce({ ...initialViewer(), panes: [{ tabs: ['a', 'b', 'c'], active: 'a' }] }, { type: 'closeOthers', pane: 0, tab: 'b' });
    expect(s.panes[0]).toEqual({ tabs: ['b'], active: 'b' });
  });

  it('unsplits without duplicates and keeps the focused pane\'s tab', () => {
    let s = reduce(initialViewer(), { type: 'split', pane: 0, tab: 'changes', dir: 'row' });
    s = reduce(s, { type: 'open', tab: 'files' });
    s = reduce(s, { type: 'unsplit' });
    expect(s.panes).toEqual([{ tabs: ['changes', 'files'], active: 'files' }]);
  });

  it('changes the layout, and expands', () => {
    let s = reduce(two(), { type: 'split', pane: 0, tab: 'file:a.md', dir: 'row' });
    s = reduce(s, { type: 'setDir', dir: 'column' });
    expect(s.dir).toBe('column');
    s = reduce({ ...s, open: false }, { type: 'toggleExpand' });
    expect(s).toMatchObject({ expanded: true, open: true });
    s = reduce(s, { type: 'toggleOpen' });
    expect(s).toMatchObject({ open: false, expanded: false });
  });

  it('keeps the width you drag to, within limits, and forgets it on reset', () => {
    let s = reduce(initialViewer(), { type: 'resize', width: 640 });
    expect(s.width).toBe(640);
    expect(reduce(s, { type: 'resize', width: 100 }).width).toBe(320);
    expect(reduce(s, { type: 'resize', width: null }).width).toBeUndefined();
  });

  it('keeps the share of the first pane between 20% and 80%', () => {
    let s = reduce(initialViewer(), { type: 'ratio', ratio: 0.3 });
    expect(s.ratio).toBe(0.3);
    expect(reduce(s, { type: 'ratio', ratio: 0.95 }).ratio).toBe(0.8);
    expect(reduce(s, { type: 'ratio', ratio: 0.01 }).ratio).toBe(0.2);
    expect(reduce(s, { type: 'ratio', ratio: null }).ratio).toBeUndefined();
  });
});
