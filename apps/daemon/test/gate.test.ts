import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/db.ts';
import { Runner } from '../src/runner.ts';
import { realExecutors, type Executors } from '../src/executors.ts';

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function waitFor(check: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return check();
}

describe('a gate that is stopped', () => {
  it('stops the processes its command started too, so a rerun finds no old one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orstra-gate-'));
    const pidFile = join(dir, 'child.pid');
    const ctrl = new AbortController();
    // The shell starts a child in the background, writes its pid, and waits. A stop that ends only
    // the shell leaves the child running, the way a dev server outlives its test script.
    const done = realExecutors.gate({
      commands: [`sleep 30 & echo $! > ${pidFile}; wait`],
      cwd: dir,
      onEvent: () => {},
      signal: ctrl.signal,
    });
    expect(await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '')).toBe(true);
    const child = Number(readFileSync(pidFile, 'utf8').trim());
    expect(alive(child)).toBe(true);

    ctrl.abort();
    const res = await done;
    expect(res.pass).toBe(false);
    expect(await waitFor(() => !alive(child))).toBe(true);
  });

  it('is stopped by a shutdown, and its run stays open for the next daemon to run again', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orstra-gate-'));
    const wf = join(dir, 'wf.yaml');
    writeFileSync(wf, 'name: X\nsteps:\n  check:\n    use: gate\n    run: ["npm test"]\n    next: end\n');
    let signal: AbortSignal | undefined;
    const exec: Executors = {
      session() { throw new Error('no agent in this workflow'); },
      gate(req) {
        signal = req.signal;
        return new Promise((resolve) => req.signal.addEventListener('abort', () => resolve({ pass: false, output: '' }), { once: true }));
      },
      async ask() { return ''; },
    };
    const store = new Store(':memory:');
    const runner = new Runner(store, exec, { slots: 1, createWorktree: () => dir });
    const task = runner.startTask({ workflowPath: wf, title: 'x' });
    await waitFor(() => signal !== undefined);

    await runner.shutdown(10);
    expect(signal!.aborted).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(store.runsForTask(task.id)[0].status).toBe('running');
  });

  it('still passes and fails on the exit code', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orstra-gate-'));
    const ctrl = new AbortController();
    expect((await realExecutors.gate({ commands: ['echo hi'], cwd: dir, onEvent: () => {}, signal: ctrl.signal })).pass).toBe(true);
    expect((await realExecutors.gate({ commands: ['exit 3'], cwd: dir, onEvent: () => {}, signal: ctrl.signal })).pass).toBe(false);
  });
});
