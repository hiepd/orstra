/**
 * May a link show in a frame in the side viewer, and what is its title?
 *
 * Many sites refuse frames (X-Frame-Options, CSP frame-ancestors). The browser does not tell a page
 * that it refused, so the daemon reads the headers and the viewer shows a card instead of a blank frame.
 */

export interface LinkInfo {
  url: string;
  frameable: boolean;
  title: string | null;
}

const TIMEOUT_MS = 5000;
const TITLE_BYTES = 64 * 1024;
const KEEP_MS = 10 * 60_000;
const cache = new Map<string, { at: number; info: LinkInfo }>();

export function frameableFrom(headers: Headers): boolean {
  const xfo = (headers.get('x-frame-options') ?? '').trim().toLowerCase();
  if (xfo === 'deny' || xfo === 'sameorigin') return false;
  const csp = headers.get('content-security-policy') ?? '';
  const fa = csp.split(';').map((d) => d.trim()).find((d) => d.toLowerCase().startsWith('frame-ancestors'));
  if (!fa) return true;
  const sources = fa.split(/\s+/).slice(1);
  // Only a wildcard lets Orstra's localhost page frame it. 'self', 'none' or a list of hosts do not.
  return sources.includes('*');
}

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };

export function titleFrom(html: string): string | null {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!m) return null;
  const t = m[1].replace(/&(amp|lt|gt|quot|#39);/g, (e) => ENTITIES[e]).replace(/\s+/g, ' ').trim();
  return t || null;
}

async function firstBytes(res: Response): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  while (n < TITLE_BYTES) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    parts.push(value);
    n += value.length;
  }
  void reader.cancel().catch(() => {});
  return new TextDecoder().decode(Buffer.concat(parts));
}

export async function linkInfo(url: string, fetcher: typeof fetch = fetch): Promise<LinkInfo> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error('That is not a URL.');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Only http and https links can open in the viewer.');
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < KEEP_MS) return hit.info;
  let info: LinkInfo;
  try {
    const res = await fetcher(url, { redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: 'text/html,*/*' } });
    const html = (res.headers.get('content-type') ?? 'text/html').includes('html') ? await firstBytes(res) : '';
    info = { url, frameable: frameableFrom(res.headers), title: titleFrom(html) };
  } catch {
    info = { url, frameable: false, title: null };
  }
  cache.set(url, { at: Date.now(), info });
  return info;
}
