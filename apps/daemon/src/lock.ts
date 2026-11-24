import { renameSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { realProcessEnv, type ProcessEnv, type ProcessStamp } from './process.ts';

/** Who holds the home folder, and where they serve. */
export interface LockRecord extends ProcessStamp {
  port: number;
}

export type Lock = { ok: true; release: () => void } | { ok: false; holder: LockRecord };

function readRecord(path: string): LockRecord | null {
  try {
    const r = JSON.parse(readFileSync(path, 'utf8')) as Partial<LockRecord>;
    if (typeof r.bootId !== 'string' || typeof r.pid !== 'number' || typeof r.startedAt !== 'string' || typeof r.port !== 'number') return null;
    if (!Number.isInteger(r.pid) || r.pid <= 1) return null;
    return r as LockRecord;
  } catch {
    return null;
  }
}

/**
 * Does the record still name a running daemon?
 *
 * An empty start time means the machine would not report one. The guard then falls back to the pid
 * alone, which is weaker but still better than no guard.
 */
function held(r: LockRecord, env: ProcessEnv): boolean {
  if (r.bootId !== env.bootId()) return false;
  const started = env.startedAt(r.pid);
  if (started === null) return false;
  return r.startedAt === '' || started === '' || started === r.startedAt;
}

/**
 * Claim a home folder for this daemon.
 *
 * Two daemons on one home both run every queued step, so a task's work happens twice. Nothing else
 * stops that: the port only clashes when both use the same one, and ORSTRA_PORT undoes even that.
 *
 * A record left by a daemon that crashed is ignored, because its process is gone. So is one from
 * before a reboot.
 */
export function takeLock(path: string, port: number, env: ProcessEnv = realProcessEnv): Lock {
  const existing = readRecord(path);
  if (existing && held(existing, env)) return { ok: false, holder: existing };

  const pid = env.self();
  const mine: LockRecord = { bootId: env.bootId(), pid, startedAt: env.startedAt(pid) ?? '', port };
  // Write beside the lock, then rename: a reader never sees half a record.
  const tmp = `${path}.${pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(mine), { mode: 0o600 });
  renameSync(tmp, path);

  let released = false;
  return {
    ok: true,
    release: () => {
      if (released) return;
      released = true;
      // Only clear our own record. Another daemon may hold the home by now.
      const now = readRecord(path);
      if (now && now.pid === mine.pid && now.bootId === mine.bootId) rmSync(path, { force: true });
    },
  };
}
