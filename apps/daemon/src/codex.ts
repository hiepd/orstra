import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { AgentSettings } from './agentConfig.ts';
import type { LiveSession, SessionOptions, StreamEvent, TurnUsage } from './executors.ts';

/**
 * Codex CLI in headless mode (`codex exec --json`). Codex takes one prompt per process, so each turn is
 * its own process: the first one starts a thread, and each later one resumes it (`exec resume <id>`).
 *
 * Differences from Claude Code that the runner sees:
 * - Codex picks the session id (its thread id). `onSessionId` reports it, and the runner stores it.
 * - A message sent while a turn works waits for that turn to end, then goes in as the next turn.
 * - Interrupt stops the turn's process. The thread stays, so the next message resumes it.
 * - Codex reports tokens but no cost.
 */
export function codexArgs(opts: { threadId?: string; model?: string; cwd: string }, cfg: AgentSettings = {}): string[] {
  const args = ['exec', '--json', '--skip-git-repo-check', '-C', opts.cwd, '-s', process.env.ORSTRA_CODEX_SANDBOX ?? 'workspace-write'];
  const model = opts.model || cfg.model;
  if (model) args.push('-m', model);
  if (opts.threadId) args.push('resume', opts.threadId);
  args.push('-'); // the prompt comes on stdin, so no length limit applies
  return args;
}

export interface CodexHandlers {
  onEvent: (e: StreamEvent) => void;
  onThread: (id: string) => void;
  onMessage: (text: string) => void;
  onDone: (u: TurnUsage | undefined) => void;
  onFailed: (message: string) => void;
}

/** Read one line of `codex exec --json` output. */
export function readCodexLine(line: string, h: CodexHandlers) {
  let msg: any;
  try { msg = JSON.parse(line); } catch { return; }
  switch (msg.type) {
    case 'thread.started':
      if (typeof msg.thread_id === 'string') h.onThread(msg.thread_id);
      return;
    case 'item.started':
    case 'item.completed': {
      const it = msg.item ?? {};
      if (it.type === 'agent_message' && msg.type === 'item.completed' && typeof it.text === 'string' && it.text.trim()) {
        h.onMessage(it.text.trim());
        h.onEvent({ kind: 'message', text: it.text.trim() });
      } else if (it.type === 'command_execution' && msg.type === 'item.started') {
        h.onEvent({ kind: 'tool', name: 'Shell', summary: String(it.command ?? '').slice(0, 140) });
      } else if (it.type === 'file_change' && msg.type === 'item.completed') {
        const paths = (it.changes ?? []).map((c: any) => c.path).filter(Boolean).join(', ');
        h.onEvent({ kind: 'tool', name: 'Edit', summary: paths.slice(0, 140) });
      } else if (it.type === 'mcp_tool_call' && msg.type === 'item.started') {
        h.onEvent({ kind: 'tool', name: `${it.server ?? 'mcp'}.${it.tool ?? ''}`, summary: '' });
      } else if (it.type === 'web_search' && msg.type === 'item.started') {
        h.onEvent({ kind: 'tool', name: 'WebSearch', summary: String(it.query ?? '').slice(0, 140) });
      }
      return;
    }
    case 'turn.completed': {
      const u = msg.usage;
      h.onDone(u ? { tokensIn: Number(u.input_tokens ?? 0), tokensOut: Number(u.output_tokens ?? 0) } : undefined);
      return;
    }
    case 'turn.failed':
      h.onFailed(errorText(msg.error?.message ?? 'Codex failed the turn.'));
      return;
  }
}

/** Codex wraps API errors as JSON in the message. Show the inner sentence. */
function errorText(m: string): string {
  try {
    const inner = JSON.parse(m);
    return inner?.error?.message ?? m;
  } catch {
    return m;
  }
}

export function codexSession(opts: SessionOptions, cfg: AgentSettings = {}): LiveSession {
  let threadId = opts.resume ? opts.sessionId : undefined;
  let child: ChildProcess | null = null;
  let interrupted = false;
  let ending = false;
  const queue: string[] = [];
  let settle!: (r: { ok: boolean; error?: string }) => void;
  const closed = new Promise<{ ok: boolean; error?: string }>((r) => (settle = r));
  let done = false;
  const close = (r: { ok: boolean; error?: string }) => {
    if (done) return;
    done = true;
    settle(r);
  };

  const run = (prompt: string) => {
    let lastText = '';
    let reported = false;
    let stderr = '';
    interrupted = false;
    const proc = spawn(process.env.ORSTRA_CODEX_BIN ?? 'codex', codexArgs({ threadId, model: opts.model, cwd: opts.cwd }, cfg), { cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    child = proc;
    proc.stdin!.end(prompt);
    proc.stderr!.on('data', (d) => { stderr += String(d); });
    const report = (t: Parameters<SessionOptions['onTurn']>[0]) => {
      if (reported) return;
      reported = true;
      opts.onTurn(t);
    };
    createInterface({ input: proc.stdout! }).on('line', (line) =>
      readCodexLine(line, {
        onEvent: opts.onEvent,
        onThread: (id) => {
          threadId = id;
          opts.onSessionId?.(id);
        },
        onMessage: (t) => { lastText = t; },
        onDone: (usage) => report({ text: lastText, interrupted: false, isError: false, usage }),
        onFailed: (message) => report({ text: message, interrupted: false, isError: true }),
      }),
    );
    proc.on('error', (err) => {
      child = null;
      report({ text: `Could not start codex: ${err.message}`, interrupted: false, isError: true });
      close({ ok: false, error: `Could not start codex: ${err.message}` });
    });
    proc.on('close', (code) => {
      child = null;
      if (interrupted) report({ text: '', interrupted: true, isError: false });
      else if (!reported) report({ text: stderr.trim().slice(-800) || `codex exited with code ${code}`, interrupted: false, isError: true });
      const next = queue.shift();
      if (next !== undefined && !done) return run(next);
      if (ending) close({ ok: true });
    });
  };

  return {
    send(text) {
      if (done) return;
      if (child) queue.push(text);
      else run(text);
    },
    interrupt() {
      if (!child) return;
      interrupted = true;
      queue.length = 0;
      child.kill('SIGINT');
    },
    end() {
      ending = true;
      queue.length = 0;
      if (!child) close({ ok: true });
    },
    kill() {
      queue.length = 0;
      child?.kill('SIGTERM');
      close({ ok: true });
    },
    closed,
  };
}

export type { ChildProcess };
