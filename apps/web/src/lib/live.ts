import { useEffect, useMemo, useRef, useState } from 'react';
import { errorMessage } from '../api';

// One shared EventSource for the whole app. Every message means "something changed";
// listeners refetch what they show (debounced).
type Listener = (taskId: string | null) => void;
const listeners = new Set<Listener>();
let source: { check(): void; stop(): void } | null = null;
let connected = false;
const connListeners = new Set<(c: boolean) => void>();

function setConnected(c: boolean) {
  if (connected === c) return;
  connected = c;
  connListeners.forEach((l) => l(c));
}

/** The part of EventSource this file uses. A test hands in its own. */
export interface StreamLike {
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  addEventListener(type: string, fn: (ev: { data: string }) => void): void;
}

/** The text an agent writes now. `after` is the task's newest event when it began: a newer event of the run makes it old. */
export interface Draft {
  taskId: string;
  runId: string;
  text: string;
  after: number;
  /** When the daemon said the draft is done. It stays until its stored message is in, or 5 s pass. */
  endedAt?: number;
}

/** How long an ended draft may stay when no newer event comes, as after an interrupt with no message. */
export const DRAFT_LINGER_MS = 5_000;

export interface LiveStreamOptions {
  create: () => StreamLike;
  onChange: (taskId: string | null) => void;
  onConnected: (c: boolean) => void;
  /** The newest draft of a run, from the named `draft` event. */
  onDraft?: (d: Draft) => void;
  /** Open the stream again once it has said nothing for this long. */
  silenceMs?: number;
  /** How often to look. */
  checkMs?: number;
  now?: () => number;
}

/** The daemon beats every 15 s (HEARTBEAT_MS). 3 missed beats mean the stream is gone. */
export const SILENCE_MS = 45_000;

/**
 * The stream of changes, with a watchdog.
 *
 * A stream can die without the browser noticing: the machine sleeps, or something in the middle
 * drops the connection and tells neither end. The browser then reports no error and reopens
 * nothing, so the UI goes quiet for good. The daemon beats every 15 s; silence for longer than
 * `silenceMs` means the stream is dead, and we open a new one.
 */
export function liveStream(opts: LiveStreamOptions): { check(): void; stop(): void } {
  const silence = opts.silenceMs ?? SILENCE_MS;
  const checkMs = opts.checkMs ?? 5_000;
  const now = opts.now ?? (() => Date.now());
  let stream: StreamLike | null = null;
  let lastSeen = now();
  let stopped = false;
  const alive = () => {
    lastSeen = now();
  };

  const open = () => {
    alive();
    const s = opts.create();
    stream = s;
    s.onopen = () => {
      alive();
      opts.onConnected(true);
      // We may have missed changes while disconnected: tell everyone to refetch.
      opts.onChange(null);
    };
    s.onerror = () => opts.onConnected(false);
    s.onmessage = (msg) => {
      alive();
      let taskId: string | null = null;
      try {
        const data = JSON.parse(msg.data) as { taskId?: unknown };
        if (typeof data.taskId === 'string') taskId = data.taskId;
      } catch {
        /* ignore malformed */
      }
      opts.onChange(taskId);
    };
    // The beat is a named event, so it never reaches onmessage and never asks for a refetch.
    s.addEventListener('ping', alive);
    // So is a draft: it shows at once, and the stored message replaces it later.
    s.addEventListener('draft', (msg) => {
      alive();
      try {
        opts.onDraft?.(JSON.parse(msg.data) as Draft);
      } catch {
        /* ignore malformed */
      }
    });
  };

  const check = () => {
    if (stopped || !stream || now() - lastSeen <= silence) return;
    opts.onConnected(false);
    stream.close();
    stream = null;
    open();
  };

  open();
  const timer = setInterval(check, checkMs);
  return {
    check,
    stop() {
      stopped = true;
      clearInterval(timer);
      stream?.close();
      stream = null;
    },
  };
}

function ensureSource() {
  if (source || typeof EventSource === 'undefined') return;
  source = liveStream({
    // EventSource types its handlers to itself; this file needs only the 4 members above.
    create: () => new EventSource('/api/events') as unknown as StreamLike,
    onChange: (taskId) => listeners.forEach((l) => l(taskId)),
    onConnected: setConnected,
    onDraft: (d) => {
      // An empty draft means "done". Keep the text until the stored message replaces it, or the page
      // would blink between the 2: the message comes with the next refetch, up to 250 ms later.
      const prev = drafts.get(d.runId);
      if (d.text) drafts.set(d.runId, d);
      else if (prev) drafts.set(d.runId, { ...prev, endedAt: Date.now() });
      draftListeners.get(d.runId)?.forEach((l) => l(drafts.get(d.runId) ?? null));
    },
  });
  // A tab that comes back from sleep: look now, instead of waiting for the next check.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') source?.check();
  });
}

/** The newest draft of each run, and who shows it. */
const drafts = new Map<string, Draft>();
const draftListeners = new Map<string, Set<(d: Draft | null) => void>>();

/** The text a run's agent is writing now, or null. It changes many times a second while the agent writes. */
export function useDraft(runId: string): Draft | null {
  const [d, setD] = useState<Draft | null>(drafts.get(runId) ?? null);
  useEffect(() => {
    ensureSource();
    let set = draftListeners.get(runId);
    if (!set) draftListeners.set(runId, (set = new Set()));
    set.add(setD);
    setD(drafts.get(runId) ?? null);
    return () => {
      set!.delete(setD);
    };
  }, [runId]);
  return d;
}

/** Is the draft still news? Not once the run has an event newer than the one the draft began after. */
export function draftIsNew(d: Draft | null, events: { id: number | string; runId: string | null }[], now = Date.now()): d is Draft {
  if (!d || !d.text) return false;
  if (d.endedAt !== undefined && now - d.endedAt > DRAFT_LINGER_MS) return false;
  // Only stored events have number ids. The page makes up string ids for its own rows.
  return !events.some((e) => e.runId === d.runId && typeof e.id === 'number' && e.id > d.after);
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

export interface Coalescer {
  push(taskId: string | null): void;
  cancel(): void;
}

/**
 * Collects the change ids that arrive together and reports them as one call, at most once per
 * `delay`. The window starts at the first change and does not restart on the next one: a working
 * agent sends a change about every 100 ms, and a window that restarted each time would never end,
 * so the chat would stand still until the agent stopped.
 */
export function coalesce(delay: number, emit: (taskId: string | null) => void): Coalescer {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending = new Set<string | null>();
  return {
    push(taskId) {
      pending.add(taskId);
      if (timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        const ids = pending;
        pending = new Set();
        // Collapse to one call: null means "anything".
        emit(ids.size === 1 ? [...ids][0] : null);
      }, delay);
    },
    cancel() {
      clearTimeout(timer);
      timer = undefined;
    },
  };
}

/** Calls `onChange` (coalesced) whenever the daemon reports a change. */
export function useLiveChanges(onChange: (taskId: string | null) => void, delay = 150) {
  const cb = useRef(onChange);
  cb.current = onChange;
  useEffect(() => {
    ensureSource();
    const group = coalesce(delay, (taskId) => cb.current(taskId));
    const l: Listener = (taskId) => group.push(taskId);
    listeners.add(l);
    return () => {
      listeners.delete(l);
      group.cancel();
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
 * Lets one run of `job` go at a time. Calls made while it runs become one more run after it.
 * A working agent asks for a refetch every window; without this a slow answer piles up behind the
 * windows that passed, and each one costs the daemon a query it throws away.
 */
export function oneAtATime(job: () => Promise<unknown>): () => void {
  let busy = false;
  let again = false;
  const go = () => {
    busy = true;
    void job()
      .catch(() => undefined)
      .then(() => {
        busy = false;
        if (!again) return;
        again = false;
        go();
      });
  };
  return () => {
    if (busy) again = true;
    else go();
  };
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
  // The key at the time a fetch starts: `reload` outlives a key change, so it must not close over one.
  const keyRef = useRef(key);
  keyRef.current = key;
  const seq = useRef(0);

  const reload = useMemo(
    () =>
      oneAtATime(() => {
        const n = ++seq.current;
        const k = keyRef.current;
        return loadRef.current().then(
          (data) => {
            if (n === seq.current) setState({ key: k, data, error: null, loading: false });
          },
          (err: unknown) => {
            if (n === seq.current) setState((s) => ({ key: k, data: s.key === k ? s.data : undefined, error: errorMessage(err), loading: false }));
          },
        );
      }),
    [],
  );

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
