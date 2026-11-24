import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, connect } from 'node:net';
import { join } from 'node:path';

/**
 * The side viewer's Browser panel: one dev server for each task, started in its worktree.
 *
 * The command gets a free port in PORT. Orstra shows the URL the server prints, or that port once it
 * answers. The command runs in its own process group, so Stop ends it and every child it started.
 */

export type DevServerState = 'stopped' | 'starting' | 'running' | 'exited';

export interface DevServerView {
  state: DevServerState;
  command: string | null;
  /** The command Orstra offers before a start: from the worktree's package.json. */
  suggested: string | null;
  url: string | null;
  port: number | null;
  /** The last 80 lines of output. */
  log: string;
  exitCode: number | null;
}

const LOG_LINES = 80;
const WAIT_MS = 60_000;
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;
const LOCAL_URL = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::\d+)?(?:\/[^\s'"<>]*)?/i;

/** The local URL in a dev server's output, with 0.0.0.0 and [::] as localhost. */
export function urlFromOutput(text: string): string | null {
  const m = LOCAL_URL.exec(text.replace(ANSI, ''));
  if (!m) return null;
  return m[0].replace(/[.,;:)\]]+$/, '').replace(/\/\/(0\.0\.0\.0|\[::\])/, '//localhost');
}

export function defaultCommand(worktree: string): string | null {
  const file = join(worktree, 'package.json');
  if (!existsSync(file)) return null;
  try {
    const scripts = JSON.parse(readFileSync(file, 'utf8')).scripts ?? {};
    return scripts.dev ? 'npm run dev' : scripts.start ? 'npm start' : null;
  } catch {
    return null;
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

function answers(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const c = connect(port, '127.0.0.1');
    c.once('connect', () => (c.destroy(), resolve(true)));
    c.once('error', () => resolve(false));
  });
}

interface Server {
  child: ChildProcess;
  command: string;
  port: number;
  url: string | null;
  state: DevServerState;
  out: string;
  exitCode: number | null;
  stopping: boolean;
  exited: Promise<void>;
}

export class DevServers extends EventEmitter {
  private servers = new Map<string, Server>();

  status(taskId: string, worktree?: string | null): DevServerView {
    const s = this.servers.get(taskId);
    const suggested = worktree ? defaultCommand(worktree) : null;
    if (!s) return { state: 'stopped', command: null, suggested, url: null, port: null, log: '', exitCode: null };
    return { state: s.state, command: s.command, suggested, url: s.url, port: s.port, log: s.out.split('\n').slice(-LOG_LINES).join('\n'), exitCode: s.exitCode };
  }

  pid(taskId: string): number | undefined {
    return this.servers.get(taskId)?.child.pid;
  }

  async start(taskId: string, cwd: string, command: string): Promise<DevServerView> {
    await this.stop(taskId);
    const port = await freePort();
    // sh -c with the daemon's own environment: its PATH already has node and npm.
    const child = spawn('/bin/sh', ['-c', command], {
      cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PORT: String(port), BROWSER: 'none' },
    });
    let done!: () => void;
    const s: Server = { child, command, port, url: null, state: 'starting', out: '', exitCode: null, stopping: false, exited: new Promise((r) => (done = r)) };
    this.servers.set(taskId, s);
    const changed = () => this.emit('change', taskId);
    const ready = (url: string) => {
      if (s.state !== 'starting') return;
      s.url = url;
      s.state = 'running';
      changed();
    };
    // A change goes out only when the state or the URL changes. A chatty server (request logs, HMR)
    // must not flood the live channel; the Browser panel reads the log while it starts.
    const onOut = (d: Buffer) => {
      s.out = (s.out + d.toString().replace(ANSI, '')).slice(-64 * 1024);
      const url = s.url ? null : urlFromOutput(s.out);
      if (url) ready(url);
    };
    child.stdout?.on('data', onOut);
    child.stderr?.on('data', onOut);
    child.on('exit', (code) => {
      s.exitCode = code;
      s.state = s.stopping ? 'stopped' : 'exited';
      done();
      changed();
    });
    child.on('error', (err) => {
      s.out += `\n${err.message}`;
    });
    // A server that prints no URL: show the port once it answers.
    const t0 = Date.now();
    const poll = async () => {
      if (s.state !== 'starting' || Date.now() - t0 > WAIT_MS) return;
      if (await answers(port)) return ready(`http://localhost:${port}/`);
      setTimeout(poll, 500);
    };
    setTimeout(poll, 500);
    changed();
    return this.status(taskId, cwd);
  }

  async stop(taskId: string): Promise<void> {
    const s = this.servers.get(taskId);
    if (!s || s.state === 'exited' || s.state === 'stopped') return;
    s.stopping = true;
    const kill = (sig: NodeJS.Signals) => {
      try {
        if (s.child.pid) process.kill(-s.child.pid, sig);
      } catch {
        /* already gone */
      }
    };
    kill('SIGTERM');
    const hard = setTimeout(() => kill('SIGKILL'), 3000);
    await s.exited;
    clearTimeout(hard);
  }

  /** Stop at once, with no grace period: the worktree is about to go. */
  kill(taskId: string) {
    const s = this.servers.get(taskId);
    if (!s || s.state === 'exited' || s.state === 'stopped') return;
    s.stopping = true;
    try {
      if (s.child.pid) process.kill(-s.child.pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }

  stopAll() {
    for (const [taskId, s] of this.servers) if (s.state === 'starting' || s.state === 'running') {
      s.stopping = true;
      try {
        if (s.child.pid) process.kill(-s.child.pid, 'SIGTERM');
      } catch {
        /* gone */
      }
      this.emit('change', taskId);
    }
  }
}
