/** "30s", "5m", "2h", "1d", or a number of minutes -> milliseconds. */
export function parseDuration(v: string | number): number {
  if (typeof v === 'number') {
    if (!(v >= 0)) throw new Error(`"${v}" is not a duration.`);
    return v * 60_000;
  }
  const m = v.trim().match(/^(\d+(?:\.\d+)?)\s*(s|sec|m|min|h|d)?$/i);
  if (!m) throw new Error(`"${v}" is not a duration. Write it like 30s, 5m, 2h or 1d.`);
  const n = Number(m[1]);
  const unit = (m[2] ?? 'm').toLowerCase();
  const ms = unit.startsWith('s') ? 1_000 : unit === 'h' ? 3_600_000 : unit === 'd' ? 86_400_000 : 60_000;
  return n * ms;
}

/** A duration for a sentence: "45 s", "5 min", "2 h", "3 d". */
export function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
  if (ms < 86_400_000) return `${Math.round((ms / 3_600_000) * 10) / 10} h`;
  return `${Math.round((ms / 86_400_000) * 10) / 10} d`;
}

/**
 * How a step tries again after a fault: a crash, an API error, or (when `onTimeout`) a timeout. A
 * fault is a failure of the system, not an outcome of the work, so the outcome arrows never see it
 * until the retries run out.
 */
export interface RetryPolicy {
  /** Retries after the first try. 0 = never. */
  max: number;
  delayMs: number;
  factor: number;
  maxDelayMs: number;
  onTimeout: boolean;
}

/** The default for an agent step: 2 retries, after 1 min and then 4 min. Other kinds: none. */
export const AGENT_RETRY: RetryPolicy = { max: 2, delayMs: 60_000, factor: 4, maxDelayMs: 30 * 60_000, onTimeout: false };
export const NO_RETRY: RetryPolicy = { max: 0, delayMs: 60_000, factor: 4, maxDelayMs: 30 * 60_000, onTimeout: false };

/** The wait before retry `n` (1 = the first retry). */
export function retryDelay(p: RetryPolicy, n: number): number {
  return Math.min(p.delayMs * p.factor ** Math.max(0, n - 1), p.maxDelayMs);
}

/**
 * When a usage limit lifts, from the error text Claude Code gives. Two forms: "usage limit
 * reached|<epoch seconds>", and "... resets 3pm" (or "resets at 3:30 pm"), read as the next such
 * time on this machine's clock. Null when the text names no time.
 */
export function usageReset(text: string, now = Date.now()): number | null {
  const epoch = text.match(/limit reached\|(\d{9,13})/i);
  if (epoch) {
    const n = Number(epoch[1]);
    return n < 1e12 ? n * 1000 : n;
  }
  const at = text.match(/limit.*?resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
  if (!at) return null;
  let h = Number(at[1]) % 12;
  if (at[3].toLowerCase() === 'pm') h += 12;
  const d = new Date(now);
  d.setHours(h, Number(at[2] ?? 0), 0, 0);
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}
