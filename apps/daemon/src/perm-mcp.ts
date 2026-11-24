/**
 * The permission tool for task agents, as an MCP server over stdio (newline-delimited JSON-RPC).
 *
 * A task agent runs with `-p`, so no person sees Claude Code's own permission prompt. Claude Code
 * calls this tool instead (`--permission-prompt-tool mcp__orstra_perm__permission_prompt`) for each
 * tool call that its permission mode and allowed tools do not already decide. The call goes to the
 * daemon, which puts the question in your Inbox and waits for your answer.
 *
 * Claude Code wants one text block back: {"behavior":"allow","updatedInput":{...}} or
 * {"behavior":"deny","message":"..."}.
 */
import { createInterface } from 'node:readline';

/** Read at call time, so a test can point it somewhere else. */
const daemon = () => process.env.ORSTRA_DAEMON_URL ?? `http://127.0.0.1:${Number(process.env.ORSTRA_PORT ?? 4317)}`;
export const PERM_TOOL = 'permission_prompt';

type Req = { jsonrpc: '2.0'; id?: number | string; method: string; params?: any };
export type Decision = { behavior: 'allow'; updatedInput: Record<string, unknown> } | { behavior: 'deny'; message: string };

export let write = (msg: unknown): void => {
  process.stdout.write(JSON.stringify(msg) + '\n');
};
export const setWriter = (w: (msg: unknown) => void) => {
  write = w;
};
const reply = (id: Req['id'], result: unknown) => write({ jsonrpc: '2.0', id, result });
const fail = (id: Req['id'], code: number, message: string) => write({ jsonrpc: '2.0', id, error: { code, message } });

const post = async (path: string, body: unknown) => {
  const res = await fetch(`${daemon()}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = (await res.json()) as any;
  if (!res.ok) throw new Error(data?.error ?? `Orstra said ${res.status}`);
  return data;
};

/**
 * Ask the daemon, then wait for the answer. Each wait is short (the daemon answers `pending` after
 * about 25 seconds), so no HTTP timeout ends a question that takes you an hour.
 */
export async function ask(tool: string, input: Record<string, unknown>, http = post): Promise<Decision> {
  try {
    const { id, decision } = await http('/api/permissions', { runId: process.env.ORSTRA_RUN_ID ?? '', tool, input });
    if (decision) return decision as Decision;
    for (;;) {
      const r = await http(`/api/permissions/${encodeURIComponent(id)}/wait`, {});
      if (r.decision) return r.decision as Decision;
    }
  } catch (err: any) {
    return { behavior: 'deny', message: `Orstra could not ask the user (${err?.message ?? err}). Do not try this tool again; say what you needed in your reply.` };
  }
}

export async function handle(req: Req): Promise<void> {
  switch (req.method) {
    case 'initialize':
      return reply(req.id, {
        protocolVersion: req.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'orstra_perm', version: '0.1.0' },
      });
    case 'ping':
      return reply(req.id, {});
    case 'tools/list':
      return reply(req.id, {
        tools: [{
          name: PERM_TOOL,
          description: 'Asks the user in Orstra whether a tool call may run.',
          inputSchema: { type: 'object', properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } }, required: ['tool_name', 'input'] },
        }],
      });
    case 'tools/call': {
      if (req.params?.name !== PERM_TOOL) return fail(req.id, -32602, `Unknown tool ${req.params?.name}`);
      const a = req.params?.arguments ?? {};
      const input = (a.input && typeof a.input === 'object' ? a.input : {}) as Record<string, unknown>;
      const d = await ask(String(a.tool_name ?? 'unknown'), input);
      const out = d.behavior === 'allow' ? { behavior: 'allow', updatedInput: d.updatedInput ?? input } : d;
      return reply(req.id, { content: [{ type: 'text', text: JSON.stringify(out) }] });
    }
    default:
      if (req.id !== undefined) fail(req.id, -32601, `Method not found: ${req.method}`);
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')) {
  createInterface({ input: process.stdin }).on('line', (line) => {
    let req: Req;
    try {
      req = JSON.parse(line);
    } catch {
      return;
    }
    void handle(req);
  });
}
