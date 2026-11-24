import { useCallback, useEffect, useState } from 'react';
import { initialViewer, reduce, type TabId, type ViewerAction, type ViewerState } from './state';

/** Each task keeps its own viewer: which tabs are open, the split, and whether it shows. */
const keyOf = (taskId: string) => `orstra.viewer.${taskId}`;
/** A tab to open when the Chat view mounts: the Inbox writes it, then goes to the Chat view. */
const pendingKey = (taskId: string) => `orstra.viewer.open.${taskId}`;

function load(taskId: string): ViewerState {
  try {
    const raw = window.localStorage.getItem(keyOf(taskId));
    const s = raw ? (JSON.parse(raw) as ViewerState) : null;
    if (s && Array.isArray(s.panes) && s.panes.length >= 1 && s.panes.length <= 2) return { ...initialViewer(), ...s };
  } catch {
    /* no storage, or an old shape: start fresh */
  }
  return initialViewer();
}

function save(taskId: string, s: ViewerState) {
  try {
    window.localStorage.setItem(keyOf(taskId), JSON.stringify(s));
  } catch {
    /* private mode: the viewer just forgets */
  }
}

export function useViewer(taskId: string): [ViewerState, (a: ViewerAction) => void] {
  const [state, setState] = useState(() => load(taskId));
  useEffect(() => {
    let s = load(taskId);
    try {
      const tab = window.localStorage.getItem(pendingKey(taskId));
      if (tab) {
        window.localStorage.removeItem(pendingKey(taskId));
        s = reduce(s, { type: 'open', tab });
      }
    } catch {
      /* nothing pending */
    }
    setState(s);
  }, [taskId]);
  const dispatch = useCallback(
    (a: ViewerAction) =>
      setState((s) => {
        const next = reduce(s, a);
        save(taskId, next);
        return next;
      }),
    [taskId],
  );
  return [state, dispatch];
}

/** From the Inbox: open this tab when the task's Chat view mounts. */
export function openInViewer(taskId: string, tab: TabId) {
  try {
    window.localStorage.setItem(pendingKey(taskId), tab);
  } catch {
    /* the Chat view opens without the tab */
  }
}
