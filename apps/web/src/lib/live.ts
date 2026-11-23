import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from '../api';

// One shared EventSource for the whole app. Every message means "something changed";
// listeners refetch what they show (debounced).
type Listener = (taskId: string | null) => void;
const listeners = new Set<Listener>();
let source: EventSource | null = null;
let connected = false;
const connListeners = new Set<(c: boolean) => void>();

function setConnected(c: boolean) {
  if (connected === c) return;
  connected = c;
  connListeners.forEach((l) => l(c));
}

function ensureSource() {
  if (source || typeof EventSource === 'undefined') return;
  source = new EventSource('/api/events');
  source.onopen = () => {
    setConnected(true);
    // We may have missed changes while disconnected: tell everyone to refetch.
    listeners.forEach((l) => l(null));
  };
  source.onerror = () => setConnected(false);
  source.onmessage = (msg: MessageEvent<string>) => {
    let taskId: string | null = null;
    try {
      const data = JSON.parse(msg.data) as { taskId?: unknown };
      if (typeof data.taskId === 'string') taskId = data.taskId;
    } catch {
      /* ignore malformed */
    }
    listeners.forEach((l) => l(taskId));
  };
}

export function useLiveConnected(): boolean {
  const [c, setC] = useState(connected);
  useEffect(() => {
    ensureSource();
    connListeners.add(setC);
    setC(connected);
    return () => {
      connListeners.delete(setC);
    };
  }, []);
  return c;
}

/** Calls `onChange` (debounced) whenever the daemon reports a change. */
export function useLiveChanges(onChange: (taskId: string | null) => void, delay = 150) {
  const cb = useRef(onChange);
  cb.current = onChange;
  useEffect(() => {
    ensureSource();
    let timer: number | undefined;
    let pending = new Set<string | null>();
    const l: Listener = (taskId) => {
      pending.add(taskId);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const ids = pending;
        pending = new Set();
        // Collapse to one call: null means "anything".
        cb.current(ids.size === 1 ? [...ids][0] : null);
      }, delay);
    };
    listeners.add(l);
    return () => {
      listeners.delete(l);
      window.clearTimeout(timer);
    };
  }, [delay]);
}

export interface Resource<T> {
  data: T | undefined;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/**
 * Fetches with `load`, then refetches on every live change. `filter` can skip changes that
 * aren't relevant (e.g. another task). Keeps the last good data while refetching.
 */
export function useLiveResource<T>(
  key: string,
  load: () => Promise<T>,
  filter?: (taskId: string | null) => boolean,
  /** How long to wait after a change before refetching. Raise it for expensive calls. */
  delay = 150,
): Resource<T> {
  const [state, setState] = useState<{ key: string; data: T | undefined; error: string | null; loading: boolean }>({
    key,
    data: undefined,
    error: null,
    loading: true,
  });
  const loadRef = useRef(load);
  loadRef.current = load;
  const seq = useRef(0);

  const reload = useCallback(() => {
    const n = ++seq.current;
    loadRef
      .current()
      .then((data) => {
        if (n === seq.current) setState({ key, data, error: null, loading: false });
      })
      .catch((err: unknown) => {
        if (n === seq.current) setState((s) => ({ key, data: s.key === key ? s.data : undefined, error: errorMessage(err), loading: false }));
      });
  }, [key]);

  useEffect(() => {
    setState((s) => (s.key === key ? s : { key, data: undefined, error: null, loading: true }));
    reload();
  }, [key, reload]);

  const filterRef = useRef(filter);
  filterRef.current = filter;
  useLiveChanges((taskId) => {
    if (taskId === null || !filterRef.current || filterRef.current(taskId)) reload();
  }, delay);

  const fresh = state.key === key;
  return { data: fresh ? state.data : undefined, error: fresh ? state.error : null, loading: !fresh || state.loading, reload };
}

/** Re-renders every `ms` so relative times stay fresh. */
export function useNow(ms = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(t);
  }, [ms]);
  return now;
}
