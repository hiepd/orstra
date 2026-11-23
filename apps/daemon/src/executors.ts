import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

/** Something the run streamed: agent text, a tool call, or a line of command output. */
export type StreamEvent =
  | { kind: 'message'; text: string }
  | { kind: 'tool'; name: string; summary: string }
  | { kind: 'output'; text: string };

/** One finished turn of a live session: the agent's final text, or an interrupt. */
export interface TurnEnd {
  text: string;
  interrupted: boolean;
  isError: boolean;
}

export interface SessionOptions {
  cwd: string;
  sessionId: string;
  /** true = continue an existing session (`--resume`), false = start a new one with this id. */
  resume: boolean;
  model?: string;
  onEvent: (e: StreamEvent) => void;
  onTurn: (t: TurnEnd) => void;
}

/**
 * A running agent session we can keep talking to. Messages sent mid-turn are read after the agent's
 * current action; `interrupt` stops the current turn but keeps the session open for the next message.
 */
export interface LiveSession {
  send(text: string): void;
  interrupt(): void;
  /** Close input; the process exits once it's idle. */
  end(): void;
  kill(): void;
  closed: Promise<{ ok: boolean; error?: string }>;
}

export interface GateRequest {
  commands: string[];
  cwd: string;
  onEvent: (e: StreamEvent) => void;
  signal: AbortSignal;
}

export interface Executors {
  session(kind: 'claude-code' | 'codex', opts: SessionOptions): LiveSession;
  gate(req: GateRequest): Promise<{ pass: boolean; output: string }>;
  ask(sessionId: string, cwd: string, question: string): Promise<string>;
}

function summarizeTool(name: string, input: Record<string, unknown>): string {
  const pick = input.file_path ?? input.path ?? input.command ?? input.pattern ?? input.url ?? input.description;
  const s = typeof pick === 'string' ? pick : JSON.stringify(input);
  return s.length > 140 ? s.slice(0, 137) + '…' : s;
}

/** Claude Code in streaming-input mode: stdin stays open, so we can message and interrupt it while it works. */
function claudeSession(opts: SessionOptions): LiveSession {
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--permission-mode', process.env.ORSTRA_CLAUDE_PERMISSION ?? 'acceptEdits',
    '--allowedTools', process.env.ORSTRA_CLAUDE_TOOLS ?? 'Bash Read Edit Write Glob Grep',
    ...(opts.resume ? ['--resume', opts.sessionId] : ['--session-id', opts.sessionId]),
  ];
  if (opts.model) args.push('--model', opts.model);

  const child = spawn(process.env.ORSTRA_CLAUDE_BIN ?? 'claude', args, { cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  let interruptPending = false;
  let lastText = '';
  let seq = 0;
  const write = (obj: unknown) => {
    if (!child.stdin.writable) return;
    child.stdin.write(JSON.stringify(obj) + '\n');
  };

  createInterface({ input: child.stdout }).on('line', (line) => {
    let msg: any;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
      for (const c of msg.message.content) {
        if (c.type === 'text' && c.text?.trim()) {
          lastText = c.text.trim();
          opts.onEvent({ kind: 'message', text: lastText });
        }
        if (c.type === 'tool_use') opts.onEvent({ kind: 'tool', name: c.name, summary: summarizeTool(c.name, c.input ?? {}) });
      }
    } else if (msg.type === 'result') {
      const interrupted = interruptPending || msg.subtype === 'error_during_execution';
      interruptPending = false;
      opts.onTurn({ text: typeof msg.result === 'string' && msg.result ? msg.result : lastText, interrupted, isError: !!msg.is_error && !interrupted });
      lastText = '';
    }
  });
  child.stderr.on('data', (d) => { stderr += String(d); });

  const closed = new Promise<{ ok: boolean; error?: string }>((resolve) => {
    child.on('error', (err) => resolve({ ok: false, error: `Could not start claude: ${err.message}` }));
    child.on('close', (code) => resolve(code === 0 ? { ok: true } : { ok: false, error: stderr.trim().slice(-800) || `claude exited with code ${code}` }));
  });

  return {
    send(text) {
      write({ type: 'user', message: { role: 'user', content: text } });
    },
    interrupt() {
      interruptPending = true;
      write({ type: 'control_request', request_id: `int-${++seq}`, request: { subtype: 'interrupt' } });
    },
    end() {
      if (child.stdin.writable) child.stdin.end();
    },
    kill() {
      child.kill('SIGTERM');
    },
    closed,
  };
}

function runShell(command: string, cwd: string, onLine: (l: string) => void, signal: AbortSignal): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    signal.addEventListener('abort', () => child.kill('SIGTERM'), { once: true });
    const take = (d: Buffer) => {
      const s = String(d);
      output += s;
      for (const l of s.split('\n')) if (l.trim()) onLine(l);
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('error', (err) => resolve({ code: 1, output: output + err.message }));
    child.on('close', (code) => resolve({ code: code ?? 1, output }));
  });
}

/** A session that fails immediately, for agents we can't run yet. */
function unsupported(message: string): LiveSession {
  return { send() {}, interrupt() {}, end() {}, kill() {}, closed: Promise.resolve({ ok: false, error: message }) };
}

export const realExecutors: Executors = {
  session(kind, opts) {
    if (kind === 'codex') return unsupported('The Codex runner is not built yet. Use agent: claude-code for now.');
    return claudeSession(opts);
  },

  async gate(req) {
    let all = '';
    for (const cmd of req.commands) {
      req.onEvent({ kind: 'tool', name: 'Shell', summary: cmd });
      const r = await runShell(cmd, req.cwd, (l) => req.onEvent({ kind: 'output', text: l }), req.signal);
      all += `$ ${cmd}\n${r.output}\n`;
      if (r.code !== 0) return { pass: false, output: all.slice(-4000) };
    }
    return { pass: true, output: all.slice(-4000) };
  },

  /** Answers from a fork of the session, so the original is untouched. */
  ask(sessionId, cwd, question) {
    return new Promise((resolve) => {
      const child = spawn(process.env.ORSTRA_CLAUDE_BIN ?? 'claude', ['-p', question, '--resume', sessionId, '--fork-session', '--output-format', 'json'], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (d) => { out += String(d); });
      child.on('error', (e) => resolve(`Could not ask: ${e.message}`));
      child.on('close', () => {
        try { resolve(JSON.parse(out).result ?? out); } catch { resolve(out.trim() || 'No answer.'); }
      });
    });
  },
};
