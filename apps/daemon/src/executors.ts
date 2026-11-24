import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { loadAgentConfig, type AgentSettings } from './agentConfig.ts';
import { PORT, TSX } from './paths.ts';
import { codexSession } from './codex.ts';

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
  /** What the turn cost, when the agent reports it. */
  usage?: TurnUsage;
}

export interface TurnUsage {
  /** Claude Code: the session's running total for this process, in US dollars. Codex reports none. */
  totalCostUsd?: number;
  /** Tokens of this turn only: input plus cache reads and cache writes. */
  tokensIn: number;
  tokensOut: number;
}

/** Read the usage of one `result` message from Claude Code's stream. */
export function usageOf(msg: any): TurnUsage | undefined {
  const u = msg?.usage;
  if (!u && typeof msg?.total_cost_usd !== 'number') return undefined;
  const n = (v: unknown) => (typeof v === 'number' ? v : 0);
  return {
    totalCostUsd: typeof msg?.total_cost_usd === 'number' ? msg.total_cost_usd : undefined,
    tokensIn: n(u?.input_tokens) + n(u?.cache_read_input_tokens) + n(u?.cache_creation_input_tokens),
    tokensOut: n(u?.output_tokens),
  };
}

export interface SessionOptions {
  cwd: string;
  sessionId: string;
  /** true = continue an existing session (`--resume`), false = start a new one with this id. */
  resume: boolean;
  model?: string;
  /** Replaces the default tool and permission flags (used by the chief of staff, which gets only Orstra's tools). */
  toolArgs?: string[];
  /** The Orstra run this session works for. With it, permission questions go to the Inbox. */
  runId?: string;
  /** Codex picks its own session id; this reports it so the runner can resume that session. */
  onSessionId?: (id: string) => void;
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
  ask(sessionId: string, cwd: string, question: string, agent?: 'claude-code' | 'codex'): Promise<string>;
}

export function summarizeTool(name: string, input: Record<string, unknown>): string {
  const pick = input.file_path ?? input.path ?? input.command ?? input.pattern ?? input.url ?? input.description ?? input.task ?? input.title ?? input.workflow;
  const s = typeof pick === 'string' ? pick : JSON.stringify(input);
  return s.length > 140 ? s.slice(0, 137) + '…' : s;
}

/** The full name Claude Code gives Orstra's permission tool. */
export const PERMISSION_TOOL = 'mcp__orstra_perm__permission_prompt';

/** The MCP server (perm-mcp.ts) that carries a run's permission questions to the daemon, as inline JSON. */
export function permissionMcpConfig(runId: string): string {
  const script = fileURLToPath(new URL('./perm-mcp.ts', import.meta.url));
  return JSON.stringify({ mcpServers: { orstra_perm: { type: 'stdio', command: TSX, args: [script], env: { ORSTRA_PORT: String(PORT), ORSTRA_RUN_ID: runId } } } });
}

/**
 * May a step's agent publish a Claude artifact? On unless you turn it off: `"artifact": false` in
 * agents.json, or ORSTRA_CLAUDE_ARTIFACT=0 in the daemon's environment. The setting wins over the
 * variable, the same way the permission mode does.
 */
export function artifactOn(cfg: AgentSettings = {}, env: NodeJS.ProcessEnv = process.env): boolean {
  if (cfg.artifact !== undefined) return cfg.artifact;
  return (env.ORSTRA_CLAUDE_ARTIFACT ?? '1') !== '0';
}

/** The tools a step's agent may use without a permission question. */
export function allowedTools(cfg: AgentSettings = {}, env: NodeJS.ProcessEnv = process.env): string {
  const tools = env.ORSTRA_CLAUDE_TOOLS ?? 'Bash Read Edit Write Glob Grep';
  if (!artifactOn(cfg, env) || /(^|\s)Artifact(\s|$)/.test(tools)) return tools;
  return `${tools} Artifact`;
}

/**
 * The environment of a Claude Code session.
 *
 * A permission question can wait hours for you. The MCP timeouts keep Claude Code from giving up on
 * the tool call. The artifact variables turn on the Artifact tool, which a `-p` session has off; a
 * step's agent needs them to publish a page. AUTO_OPEN=0 keeps a browser tab from opening on your
 * machine while a task runs. The chief of staff passes its own tool flags, and its session is left
 * as it is.
 */
export function claudeEnv(opts: Pick<SessionOptions, 'toolArgs'>, cfg: AgentSettings = {}, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, MCP_TOOL_TIMEOUT: base.MCP_TOOL_TIMEOUT ?? '86400000', CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT: '0', CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: '0' };
  if (!opts.toolArgs && artifactOn(cfg, base)) {
    env.CLAUDE_CODE_ARTIFACT = '1';
    env.CLAUDE_CODE_ARTIFACT_AUTO_OPEN = '0';
  }
  return env;
}

/** The claude command line for a session. A model set by the caller (a workflow step) wins over the configured default. */
export function claudeArgs(opts: Pick<SessionOptions, 'sessionId' | 'resume' | 'model' | 'toolArgs' | 'runId'>, cfg: AgentSettings = {}): string[] {
  // Without --strict-mcp-config, so the agent keeps your own MCP servers next to Orstra's permission tool.
  const ask = !opts.toolArgs && opts.runId && cfg.askPermission !== false
    ? ['--mcp-config', permissionMcpConfig(opts.runId), '--permission-prompt-tool', PERMISSION_TOOL]
    : [];
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    ...(opts.toolArgs ?? ['--permission-mode', cfg.permissionMode ?? process.env.ORSTRA_CLAUDE_PERMISSION ?? 'acceptEdits', '--allowedTools', allowedTools(cfg)]),
    ...ask,
    ...(opts.resume ? ['--resume', opts.sessionId] : ['--session-id', opts.sessionId]),
  ];
  const model = opts.model || cfg.model;
  if (model) args.push('--model', model);
  if (cfg.effort) args.push('--effort', cfg.effort);
  return args;
}

/** Claude Code in streaming-input mode: stdin stays open, so we can message and interrupt it while it works. */
function claudeSession(opts: SessionOptions): LiveSession {
  const cfg = loadAgentConfig()['claude-code'];
  const args = claudeArgs(opts, cfg);
  const env = claudeEnv(opts, cfg);
  const child = spawn(process.env.ORSTRA_CLAUDE_BIN ?? 'claude', args, { cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'], env });
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
      opts.onTurn({ text: typeof msg.result === 'string' && msg.result ? msg.result : lastText, interrupted, isError: !!msg.is_error && !interrupted, usage: usageOf(msg) });
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


export const realExecutors: Executors = {
  session(kind, opts) {
    if (kind === 'codex') return codexSession(opts, loadAgentConfig().codex);
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
  ask(sessionId, cwd, question, agent) {
    if (agent === 'codex') return Promise.resolve('Ask on the side works with Claude Code sessions only. Message the Codex session in Chat instead.');
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
