import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { SCROLLBACK_BYTES, Terminals, type PtyModule } from '../src/terminals.ts';

const dir = mkdtempSync(join(tmpdir(), 'orstra-term-'));
const real = new Terminals({ shell: '/bin/sh', args: [] });
afterAll(() => real.closeAll());

const until = (fn: () => boolean, ms = 5000) =>
  new Promise<void>((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => (fn() ? resolve() : Date.now() - t0 > ms ? reject(new Error('timed out')) : setTimeout(tick, 20));
    tick();
  });

/** A pty that echoes what it gets, so a test can push bytes through without a shell. */
function stubPty(): PtyModule {
  return {
    spawn: () => {
      const ev = new EventEmitter();
      return {
        pid: 1,
        onData: (cb: (d: string) => void) => (ev.on('data', cb), { dispose: () => {} }),
        onExit: (cb: (e: { exitCode: number }) => void) => (ev.on('exit', cb), { dispose: () => {} }),
        write: (d: string) => ev.emit('data', d),
        resize: () => {},
        kill: () => ev.emit('exit', { exitCode: 0 }),
      };
    },
  };
}

describe('Terminals', () => {
  it('runs a real shell in the folder and keeps what it printed', async () => {
    const t = await real.open('task-a', dir);
    let seen = '';
    real.on('data', (id: string, chunk: string) => id === t.id && (seen += chunk));
    real.write(t.id, 'echo hi-orstra; pwd\n');
    await until(() => seen.includes('hi-orstra') && seen.includes('orstra-term-'));
    expect(real.get(t.id)?.scrollback).toContain('hi-orstra');
    const exited = new Promise((r) => real.once('exit', r));
    real.close(t.id);
    await exited;
    expect(real.list('task-a')).toEqual([]);
  });

  it('keeps only the last 256 KB of output', async () => {
    const terms = new Terminals({ load: async () => stubPty() });
    const t = await terms.open('task-b', dir);
    const chunk = 'x'.repeat(1024);
    for (let i = 0; i < 300; i++) terms.write(t.id, chunk);
    terms.write(t.id, 'END');
    const sb = terms.get(t.id)!.scrollback;
    expect(sb.length).toBeLessThanOrEqual(SCROLLBACK_BYTES);
    expect(sb.endsWith('END')).toBe(true);
    expect(SCROLLBACK_BYTES).toBe(256 * 1024);
  });

  it('says that node-pty did not load', async () => {
    const terms = new Terminals({ load: async () => { throw new Error('no prebuild'); } });
    await expect(terms.open('task-c', dir)).rejects.toThrow(/node-pty/);
  });

  it('closes only the terminals of one task', async () => {
    const terms = new Terminals({ load: async () => stubPty() });
    await terms.open('one', dir);
    await terms.open('one', dir);
    const keep = await terms.open('two', dir);
    terms.closeTask('one');
    expect(terms.list('one')).toEqual([]);
    expect(terms.list('two').map((t) => t.id)).toEqual([keep.id]);
    expect(terms.list('two')[0].title).toBe('Terminal 1');
  });
});
