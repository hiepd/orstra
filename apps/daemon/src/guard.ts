import type { IncomingHttpHeaders } from 'node:http';

/**
 * The daemon listens on 127.0.0.1, but a web page in your browser can still send requests there. The
 * chief of staff runs every tool without asking, so a request a page sends is a command on your machine.
 *
 * Three checks close that:
 * - Host must name this machine. A DNS-rebinding page has its own name in Host.
 * - Origin, when the browser sends one, must be Orstra's own UI. A page on another site has its own origin.
 * - A request that changes something must say `content-type: application/json`. A browser sends that
 *   from another site only after a preflight check, and the daemon answers no preflight.
 *
 * The CLI and the MCP servers send no Origin. They are processes on this machine, so they pass.
 */
export interface GuardOptions {
  port: number;
  /** Ports of other Orstra UIs, such as the Vite dev server (5317). */
  uiPorts?: number[];
  /** More host names to accept, from ORSTRA_ALLOWED_HOSTS. */
  extraHosts?: string[];
}

const LOCAL_NAMES = ['localhost', '127.0.0.1', '[::1]'];
const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function guardOptionsFromEnv(port: number): GuardOptions {
  const uiPorts = (process.env.ORSTRA_UI_PORTS ?? '5317').split(',').map((s) => Number(s.trim())).filter((n) => n > 0);
  const extraHosts = (process.env.ORSTRA_ALLOWED_HOSTS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return { port, uiPorts, extraHosts };
}

/** Why the request is refused, or null when it may go on. */
export function refuseReason(method: string | undefined, headers: IncomingHttpHeaders, opts: GuardOptions): string | null {
  const ports = [opts.port, ...(opts.uiPorts ?? [])];
  const hostOk = (h: string) => {
    const host = h.toLowerCase();
    if (opts.extraHosts?.includes(host)) return true;
    return LOCAL_NAMES.some((n) => ports.some((p) => host === `${n}:${p}`)) || LOCAL_NAMES.includes(host);
  };

  const host = String(headers.host ?? '');
  if (!host || !hostOk(host)) return `Host "${host}" is not this machine.`;

  const origin = headers.origin;
  if (origin !== undefined) {
    let ok = false;
    try {
      const u = new URL(String(origin));
      ok = (u.protocol === 'http:' || u.protocol === 'https:') && hostOk(u.host);
    } catch {
      ok = false;
    }
    if (!ok) return `Origin "${origin}" is not Orstra.`;
  }
  if (headers['sec-fetch-site'] === 'cross-site') return 'A request from another site.';

  if (UNSAFE.has(String(method).toUpperCase())) {
    const type = String(headers['content-type'] ?? '').toLowerCase();
    if (!type.startsWith('application/json')) return 'Send content-type: application/json.';
  }
  return null;
}
