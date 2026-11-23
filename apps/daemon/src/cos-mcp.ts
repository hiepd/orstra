/**
 * Orstra's tools for the chief of staff, as an MCP server over stdio (newline-delimited JSON-RPC).
 * Claude Code starts this process; every tool call is forwarded to the daemon, which decides whether
 * the action runs now or waits for the user's OK.
 */
import { createInterface } from 'node:readline';
import { COS_TOOLS } from './cos-tools.ts';

const PORT = Number(process.env.ORSTRA_PORT ?? 4317);
const DAEMON = process.env.ORSTRA_DAEMON_URL ?? `http://127.0.0.1:${PORT}`;

type Req = { jsonrpc: '2.0'; id?: number | string; method: string; params?: any };

/** Where replies go; tests swap it out. */
export let write = (msg: unknown): void => {
  process.stdout.write(JSON.stringify(msg) + '\n');
};
export const setWriter = (w: (msg: unknown) => void) => {
  write = w;
};
const reply = (id: Req['id'], result: unknown) => write({ jsonrpc: '2.0', id, result });
const fail = (id: Req['id'], code: number, message: string) => write({ jsonrpc: '2.0', id, error: { code, message } });

async function call(name: string, args: unknown): Promise<{ text: string; isError: boolean }> {
  try {
    const res = await fetch(`${DAEMON}/api/cos/tool`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, args: args ?? {} }) });
    const body = (await res.json()) as { text?: string; error?: string };
    return res.ok ? { text: body.text ?? '', isError: false } : { text: body.error ?? `Orstra said ${res.status}`, isError: true };
  } catch {
    return { text: 'Can’t reach the Orstra daemon.', isError: true };
  }
}

export async function handle(req: Req): Promise<void> {
  switch (req.method) {
    case 'initialize':
      return reply(req.id, {
        protocolVersion: req.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'orstra', version: '0.1.0' },
      });
    case 'ping':
      return reply(req.id, {});
    case 'tools/list':
      return reply(req.id, {
        tools: COS_TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: { type: 'object', properties: t.properties, required: t.required } })),
      });
    case 'tools/call': {
      const name = String(req.params?.name ?? '');
      if (!COS_TOOLS.some((t) => t.name === name)) return fail(req.id, -32602, `Unknown tool ${name}`);
      const r = await call(name, req.params?.arguments);
      return reply(req.id, { content: [{ type: 'text', text: r.text }], isError: r.isError });
    }
    default:
      // Notifications (no id) need no answer; unknown requests get "method not found".
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
