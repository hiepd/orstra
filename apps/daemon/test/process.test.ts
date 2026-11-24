import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { bootId, isSameProcess, realProcessEnv, stampOf, stopProcess, type ProcessEnv } from '../src/process.ts';

/** An env that answers from a table, so a test can describe any machine. */
const fake = (opts: { boot?: string; self?: number; started?: Record<number, string> }): ProcessEnv => ({
  bootId: () => opts.boot ?? 'boot-1',
  self: () => opts.self ?? 100,
  startedAt: (pid) => opts.started?.[pid] ?? null,
});

/** A child that exits on SIGTERM, and one that refuses to. */
const child = (stubborn: boolean) =>
  spawn(process.execPath, ['-e', stubborn ? "process.on('SIGTERM',()=>{});setInterval(()=>{},50)" : 'setInterval(()=>{},50)'], { stdio: 'ignore' });

describe('bootId', () => {
  it('reads one id for this boot and reads the same one again', () => {
    const a = bootId();
    expect(a).toMatch(/^[0-9a-f-]{36}$/i);
    expect(bootId()).toBe(a);
  });
});

describe('stampOf', () => {
  it('stamps this process', () => {
    const s = stampOf(process.pid);
    expect(s?.pid).toBe(process.pid);
    expect(s?.bootId).toBe(bootId());
    expect(s?.startedAt).toBeTruthy();
  });

  it('stamps nothing for a process that is not there', () => {
    expect(stampOf(0x7fff_fffe)).toBeNull();
  });
});

describe('isSameProcess', () => {
  it('says yes for this process', () => {
    expect(isSameProcess(stampOf(process.pid))).toBe(true);
  });

  it('says no for nothing at all', () => {
    expect(isSameProcess(null)).toBe(false);
    expect(isSameProcess(undefined)).toBe(false);
  });

  it('says no after a reboot, because the stamp names an earlier boot', () => {
    const env = fake({ boot: 'boot-2', started: { 42: 'Mon Nov 24 09:00:00 2026' } });
    expect(isSameProcess({ bootId: 'boot-1', pid: 42, startedAt: 'Mon Nov 24 09:00:00 2026' }, env)).toBe(false);
  });

  it('says no when the process is gone', () => {
    const env = fake({ boot: 'boot-1', started: {} });
    expect(isSameProcess({ bootId: 'boot-1', pid: 42, startedAt: 'Mon Nov 24 09:00:00 2026' }, env)).toBe(false);
  });

  it('says no when the system gave that pid to someone else', () => {
    // The pid is alive, but it started later: a bare pid would have killed a stranger.
    const env = fake({ boot: 'boot-1', started: { 42: 'Mon Nov 24 11:30:00 2026' } });
    expect(isSameProcess({ bootId: 'boot-1', pid: 42, startedAt: 'Mon Nov 24 09:00:00 2026' }, env)).toBe(false);
  });
});

describe('stopProcess', () => {
  it('reports a process that is already gone', async () => {
    expect(await stopProcess(0x7fff_fffe)).toBe('gone');
  });

  it('ends a process that takes SIGTERM', async () => {
    const c = child(false);
    await new Promise((r) => setTimeout(r, 120));
    expect(await stopProcess(c.pid!, { graceMs: 2_000, pollMs: 20 })).toBe('exited');
  });

  it('kills a process that ignores SIGTERM', async () => {
    const c = child(true);
    await new Promise((r) => setTimeout(r, 120));
    expect(await stopProcess(c.pid!, { graceMs: 250, killMs: 2_000, pollMs: 20 })).toBe('killed');
  });

  it('never signals pid 0 or the whole group', async () => {
    // process.kill(0, …) signals every process in our group. Refuse it.
    await expect(stopProcess(0)).rejects.toThrow();
    await expect(stopProcess(-1)).rejects.toThrow();
  });
});

describe('realProcessEnv', () => {
  it('reports our own pid', () => {
    expect(realProcessEnv.self()).toBe(process.pid);
  });
});
