import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { takeLock, type LockRecord } from '../src/lock.ts';
import type { ProcessEnv } from '../src/process.ts';

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orstra-lock-'));
  path = join(dir, 'daemon.lock');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A machine the test describes: which boot it is on, and which pids run since when. */
const env = (boot: string, self: number, started: Record<number, string>): ProcessEnv => ({
  bootId: () => boot,
  self: () => self,
  startedAt: (pid) => started[pid] ?? null,
});

const ME = env('boot-1', 100, { 100: 'ten o clock' });
const read = () => JSON.parse(readFileSync(path, 'utf8')) as LockRecord;

describe('takeLock', () => {
  it('takes a lock nobody holds', () => {
    const lock = takeLock(path, 4317, ME);
    expect(lock.ok).toBe(true);
    expect(read()).toMatchObject({ bootId: 'boot-1', pid: 100, port: 4317 });
  });

  it('refuses while a live daemon holds it, and says which one', () => {
    takeLock(path, 4317, ME);
    const second = takeLock(path, 4317, env('boot-1', 200, { 100: 'ten o clock', 200: 'eleven' }));
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.holder).toMatchObject({ pid: 100, port: 4317 });
  });

  it('takes the lock after the holder releases it', () => {
    const first = takeLock(path, 4317, ME);
    if (first.ok) first.release();
    expect(takeLock(path, 4317, env('boot-1', 200, { 200: 'eleven' })).ok).toBe(true);
  });

  it('takes the lock when the record names a process that died', () => {
    // The daemon was killed, so nothing released the lock.
    writeFileSync(path, JSON.stringify({ bootId: 'boot-1', pid: 100, startedAt: 'ten o clock', port: 4317 }));
    expect(takeLock(path, 4317, env('boot-1', 200, { 200: 'eleven' })).ok).toBe(true);
  });

  it('takes the lock when the record is from an earlier boot', () => {
    // After a reboot that pid belongs to someone else, whatever it is doing.
    writeFileSync(path, JSON.stringify({ bootId: 'boot-0', pid: 200, startedAt: 'eleven', port: 4317 }));
    expect(takeLock(path, 4317, env('boot-1', 200, { 200: 'eleven' })).ok).toBe(true);
  });

  it('takes the lock when the system gave that pid to someone else', () => {
    writeFileSync(path, JSON.stringify({ bootId: 'boot-1', pid: 300, startedAt: 'ten o clock', port: 4317 }));
    const taken = takeLock(path, 4317, env('boot-1', 200, { 200: 'eleven', 300: 'much later' }));
    expect(taken.ok).toBe(true);
  });

  it('takes the lock when the record is not readable', () => {
    writeFileSync(path, 'not json at all');
    expect(takeLock(path, 4317, env('boot-1', 200, { 200: 'eleven' })).ok).toBe(true);
  });

  it('leaves the file alone when release comes after another daemon took it', () => {
    const first = takeLock(path, 4317, ME);
    // The first daemon's record is gone from disk: another one took over.
    writeFileSync(path, JSON.stringify({ bootId: 'boot-1', pid: 200, startedAt: 'eleven', port: 4318 }));
    if (first.ok) first.release();
    expect(read()).toMatchObject({ pid: 200, port: 4318 });
  });

  it('is safe to release twice', () => {
    const lock = takeLock(path, 4317, ME);
    if (lock.ok) {
      lock.release();
      expect(() => lock.release()).not.toThrow();
    }
  });

  it('still guards by pid when the machine will not report a start time', () => {
    // A locked-down host with no usable ps. The guard degrades, it does not vanish.
    const noPs = (boot: string, self: number, alive: number[]): ProcessEnv => ({
      bootId: () => boot,
      self: () => self,
      startedAt: (pid) => (alive.includes(pid) ? '' : null),
    });
    const first = takeLock(path, 4317, noPs('boot-1', 100, [100]));
    expect(first.ok).toBe(true);
    expect(takeLock(path, 4317, noPs('boot-1', 200, [100, 200])).ok).toBe(false);
  });
});
