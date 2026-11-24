import { describe, expect, it } from 'vitest';
import { serialQueue } from '../src/lib/serial';

describe('serialQueue', () => {
  it('starts each job only after the one before it ends, in order', async () => {
    const run = serialQueue();
    const log: string[] = [];
    const job = (name: string, ms: number) => () => new Promise<void>((ok) => {
      log.push(`start ${name}`);
      setTimeout(() => (log.push(`end ${name}`), ok()), ms);
    });
    run(job('a', 30));
    run(job('b', 1));
    const last = run(job('c', 1));
    await last;
    expect(log).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
  });

  it('goes on after a job that fails', async () => {
    const run = serialQueue();
    run(() => Promise.reject(new Error('x')));
    let ran = false;
    await run(async () => { ran = true; });
    expect(ran).toBe(true);
  });
});
