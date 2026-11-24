import { EventEmitter } from 'node:events';
import { chmodSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Shells for the side viewer's Terminal panel: a login shell in the task's worktree, on a real pty, so
 * prompts, colours and full-screen programs work.
 *
 * The browser gets the output as Server-Sent Events and sends keys as JSON POST (see server.ts), so
 * the terminal goes through the same guard as every other route.
 */

/** The output kept for each terminal, so a page that comes back sees the screen again. */
export const SCROLLBACK_BYTES = 256 * 1024;

interface Disposable { dispose(): void }
export interface Pty {
  pid: number;
  onData(cb: (d: string) => void): Disposable;
  onExit(cb: (e: { exitCode: number }) => void): Disposable;
  write(d: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}
export interface PtyModule {
  spawn(file: string, args: string[], opts: { name: string; cols: number; rows: number; cwd: string; env: NodeJS.ProcessEnv }): Pty;
}

export interface TerminalInfo {
  id: string;
  taskId: string;
  title: string;
  cwd: string;
  alive: boolean;
  createdAt: number;
}

interface Term extends TerminalInfo {
  pty: Pty;
  scrollback: string;
}

/** node-pty, with the execute bit put back on its spawn helper: npm drops it from the prebuilds. */
async function loadNodePty(): Promise<PtyModule> {
  const require = createRequire(import.meta.url);
  try {
    const root = dirname(require.resolve('node-pty/package.json'));
    chmodSync(join(root, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'), 0o755);
  } catch {
    /* Not every platform has the helper (Windows), and a source build has it in build/. */
  }
  return (await import('node-pty')) as unknown as PtyModule;
}

export class Terminals extends EventEmitter {
  private terms = new Map<string, Term>();
  private counts = new Map<string, number>();
  private mod: Promise<PtyModule> | null = null;

  constructor(private opts: { load?: () => Promise<PtyModule>; shell?: string; args?: string[] } = {}) {
    super();
    // Each open page holds 2 listeners (data, exit), so the default warning at 10 is wrong here.
    this.setMaxListeners(0);
  }

  private pty(): Promise<PtyModule> {
    this.mod ??= (this.opts.load ?? loadNodePty)().catch((err) => {
      this.mod = null;
      throw new Error(`The terminal needs node-pty, and it did not load: ${err?.message ?? err}`);
    });
    return this.mod;
  }

  async open(taskId: string, cwd: string): Promise<TerminalInfo> {
    const mod = await this.pty();
    const n = (this.counts.get(taskId) ?? 0) + 1;
    this.counts.set(taskId, n);
    const pty = mod.spawn(this.opts.shell ?? process.env.SHELL ?? '/bin/zsh', this.opts.args ?? ['-l'], {
      name: 'xterm-256color', cols: 100, rows: 30, cwd, env: { ...process.env, TERM: 'xterm-256color' },
    });
    const t: Term = { id: randomUUID(), taskId, title: `Terminal ${n}`, cwd, alive: true, createdAt: Date.now(), pty, scrollback: '' };
    this.terms.set(t.id, t);
    pty.onData((d) => {
      t.scrollback = (t.scrollback + d).slice(-SCROLLBACK_BYTES);
      this.emit('data', t.id, d);
    });
    pty.onExit(({ exitCode }) => {
      t.alive = false;
      this.terms.delete(t.id);
      this.emit('exit', t.id, exitCode);
    });
    return this.info(t);
  }

  private info(t: Term): TerminalInfo {
    return { id: t.id, taskId: t.taskId, title: t.title, cwd: t.cwd, alive: t.alive, createdAt: t.createdAt };
  }

  list(taskId: string): TerminalInfo[] {
    return [...this.terms.values()].filter((t) => t.taskId === taskId).map((t) => this.info(t));
  }

  get(id: string): (TerminalInfo & { scrollback: string }) | undefined {
    const t = this.terms.get(id);
    return t ? { ...this.info(t), scrollback: t.scrollback } : undefined;
  }

  write(id: string, data: string) {
    this.terms.get(id)?.pty.write(data);
  }

  resize(id: string, cols: number, rows: number) {
    const t = this.terms.get(id);
    if (t && cols > 0 && rows > 0) t.pty.resize(Math.min(cols, 500), Math.min(rows, 200));
  }

  close(id: string) {
    const t = this.terms.get(id);
    if (!t) return;
    try {
      t.pty.kill();
    } catch {
      /* already gone */
    }
  }

  closeTask(taskId: string) {
    for (const t of [...this.terms.values()]) if (t.taskId === taskId) this.close(t.id);
  }

  closeAll() {
    for (const id of [...this.terms.keys()]) this.close(id);
  }
}
