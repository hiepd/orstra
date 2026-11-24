import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { coalesce, liveStream, oneAtATime, type StreamLike } from '../src/lib/live';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** Report what a change listener got, in order. */
function sink() {
  const got: (string | null)[] = [];
  return { got, emit: (id: string | null) => got.push(id) };
}

describe('coalesce', () => {
  it('reports one call for a burst that arrives together', () => {
    const s = sink();
    const c = coalesce(150, s.emit);
    c.push('t1');
    c.push('t1');
    c.push('t1');
    expect(s.got).toEqual([]);
    vi.advanceTimersByTime(150);
    expect(s.got).toEqual(['t1']);
  });

  it('reports null when the burst covers more than one task', () => {
    const s = sink();
    const c = coalesce(150, s.emit);
    c.push('t1');
    c.push('t2');
    vi.advanceTimersByTime(150);
    expect(s.got).toEqual([null]);
  });

  it('keeps reporting while an agent streams', () => {
    // The daemon sends a change for a working task about every 100 ms. The window is longer than
    // that, so a window that restarts on every change never ends: the chat would freeze until the
    // agent stops. Report on every window instead.
    const s = sink();
    const c = coalesce(150, s.emit);
    for (let i = 0; i < 20; i++) {
      c.push('t1');
      vi.advanceTimersByTime(100);
    }
    // 20 changes over 2 seconds, one report per 150 ms window.
    expect(s.got.length).toBeGreaterThanOrEqual(10);
    expect(new Set(s.got)).toEqual(new Set(['t1']));
  });

  it('reports at most once per window', () => {
    const s = sink();
    const c = coalesce(150, s.emit);
    for (let i = 0; i < 100; i++) {
      c.push('t1');
      vi.advanceTimersByTime(10);
    }
    // 1 second of changes every 10 ms: about 7 windows, never 100 calls.
    expect(s.got.length).toBeLessThanOrEqual(8);
    expect(s.got.length).toBeGreaterThanOrEqual(5);
  });

  it('stops reporting after cancel', () => {
    const s = sink();
    const c = coalesce(150, s.emit);
    c.push('t1');
    c.cancel();
    vi.advanceTimersByTime(1000);
    expect(s.got).toEqual([]);
  });
});

/** An EventSource the test drives by hand. */
class FakeStream implements StreamLike {
  static made: FakeStream[] = [];
  closed = false;
  onopen: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  private named = new Map<string, () => void>();
  constructor() {
    FakeStream.made.push(this);
  }
  addEventListener(type: string, fn: () => void) {
    this.named.set(type, fn);
  }
  close() {
    this.closed = true;
  }
  open() {
    this.onopen?.({});
  }
  beat() {
    this.named.get('ping')?.();
  }
  change(taskId: string) {
    this.onmessage?.({ data: JSON.stringify({ taskId }) });
  }
}

describe('liveStream', () => {
  const setup = () => {
    FakeStream.made = [];
    const changes: (string | null)[] = [];
    const conn: boolean[] = [];
    const s = liveStream({
      create: () => new FakeStream(),
      onChange: (id) => changes.push(id),
      onConnected: (c) => conn.push(c),
      silenceMs: 45_000,
      checkMs: 5_000,
    });
    return { s, changes, conn, made: () => FakeStream.made };
  };

  it('opens one stream and reports what it says', () => {
    const t = setup();
    expect(t.made().length).toBe(1);
    t.made()[0].open();
    t.made()[0].change('t1');
    // null first: an open stream may have missed changes, so everything refetches once.
    expect(t.changes).toEqual([null, 't1']);
    expect(t.conn).toEqual([true]);
    t.s.stop();
  });

  it('opens the stream again when the beat stops', () => {
    const t = setup();
    t.made()[0].open();
    // The daemon beats every 15 s. Silence past 45 s means the stream is dead, even though the
    // browser never reported an error: a half-open connection looks fine from here.
    vi.advanceTimersByTime(50_000);
    expect(t.made()[0].closed).toBe(true);
    expect(t.made().length).toBe(2);
    t.s.stop();
  });

  it('leaves a beating stream alone', () => {
    const t = setup();
    t.made()[0].open();
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(15_000);
      t.made()[0].beat();
    }
    expect(t.made().length).toBe(1);
    expect(t.made()[0].closed).toBe(false);
    t.s.stop();
  });

  it('does not refetch for a beat', () => {
    const t = setup();
    t.made()[0].open();
    t.changes.length = 0;
    t.made()[0].beat();
    t.made()[0].beat();
    expect(t.changes).toEqual([]);
    t.s.stop();
  });

  it('refetches everything after it opens again, so nothing missed stays missed', () => {
    const t = setup();
    t.made()[0].open();
    t.changes.length = 0;
    vi.advanceTimersByTime(50_000);
    t.made()[1].open();
    expect(t.changes).toEqual([null]);
    t.s.stop();
  });

  it('closes the stream and stops looking when it is stopped', () => {
    const t = setup();
    t.made()[0].open();
    t.s.stop();
    expect(t.made()[0].closed).toBe(true);
    vi.advanceTimersByTime(120_000);
    expect(t.made().length).toBe(1);
  });
});

describe('oneAtATime', () => {
  /** A job whose promise the test resolves by hand. */
  const job = () => {
    const calls: (() => void)[] = [];
    const run = () => new Promise<void>((resolve) => calls.push(() => resolve()));
    return { run, calls };
  };

  it('runs the job once', async () => {
    const j = job();
    const go = oneAtATime(j.run);
    go();
    expect(j.calls.length).toBe(1);
  });

  it('runs once more after a busy stretch, however many calls came in', async () => {
    const j = job();
    const go = oneAtATime(j.run);
    go();
    // 5 more windows while the first fetch is still out.
    for (let i = 0; i < 5; i++) go();
    expect(j.calls.length).toBe(1);
    j.calls[0]();
    await Promise.resolve();
    await Promise.resolve();
    expect(j.calls.length).toBe(2);
    j.calls[1]();
    await Promise.resolve();
    await Promise.resolve();
    expect(j.calls.length).toBe(2);
  });

  it('keeps going after the job fails', async () => {
    let n = 0;
    const go = oneAtATime(() => {
      n++;
      return n === 1 ? Promise.reject(new Error('offline')) : Promise.resolve();
    });
    go();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    go();
    expect(n).toBe(2);
  });
});
