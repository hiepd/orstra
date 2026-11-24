import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/**
 * Enough to tell one process from another.
 *
 * A pid alone is not enough: the system hands the same number out again, so a stale pid can name a
 * process that has nothing to do with the one that wrote it. The start time settles that. The boot
 * id settles the rest, because after a reboot every pid is someone else's.
 */
export interface ProcessStamp {
  bootId: string;
  pid: number;
  /** When the system started that pid, as the machine reports it. Compared as text. */
  startedAt: string;
}

export interface ProcessEnv {
  bootId(): string;
  /** The start time of a live pid, or null when no such process runs. */
  startedAt(pid: number): string | null;
  /** This process's own pid. */
  self(): number;
}

let cachedBootId: string | undefined;

/** This boot, as the kernel names it. The same for every process until the machine restarts. */
export function bootId(): string {
  if (cachedBootId) return cachedBootId;
  const read = () =>
    process.platform === 'darwin'
      ? execFileSync('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], { encoding: 'utf8', timeout: 2_000 })
      : readFileSync('/proc/sys/kernel/random/boot_id', 'utf8');
  cachedBootId = read().trim();
  return cachedBootId;
}

/** The start time of a live pid. null when the process is not there, so this doubles as a liveness check. */
export function startedAt(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  try {
    const out = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 2_000, stdio: ['ignore', 'pipe', 'ignore'] });
    return out.trim() || null;
  } catch {
    // ps exits non-zero when no such process runs.
    return null;
  }
}

export const realProcessEnv: ProcessEnv = { bootId, startedAt, self: () => process.pid };

/** Stamp a live pid, or null when it is not running. */
export function stampOf(pid: number, env: ProcessEnv = realProcessEnv): ProcessStamp | null {
  const started = env.startedAt(pid);
  return started === null ? null : { bootId: env.bootId(), pid, startedAt: started };
}

/** true when the process the stamp names is still running, and is still the same one. */
export function isSameProcess(stamp: ProcessStamp | null | undefined, env: ProcessEnv = realProcessEnv): boolean {
  if (!stamp || !Number.isInteger(stamp.pid) || stamp.pid <= 1) return false;
  if (stamp.bootId !== env.bootId()) return false;
  const started = env.startedAt(stamp.pid);
  return started !== null && started === stamp.startedAt;
}

export type StopResult = 'gone' | 'exited' | 'killed';

/**
 * End one process: SIGTERM, then SIGKILL when it will not go. Returns what it took.
 *
 * Warning. Never call this with a pid of 0 or below. Those signal every process in our own group,
 * so the daemon would stop itself.
 */
export async function stopProcess(pid: number, opts: { graceMs?: number; killMs?: number; pollMs?: number } = {}): Promise<StopResult> {
  if (!Number.isInteger(pid) || pid <= 1) throw new Error(`Refusing to signal pid ${pid}`);
  const { graceMs = 5_000, killMs = 1_000, pollMs = 100 } = opts;
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  if (!alive()) return 'gone';

  const waitForExit = async (ms: number) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (!alive()) return true;
      await new Promise((r) => setTimeout(r, pollMs));
    }
    return !alive();
  };

  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return 'gone';
  }
  if (await waitForExit(graceMs)) return 'exited';
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    return 'exited';
  }
  await waitForExit(killMs);
  return 'killed';
}
