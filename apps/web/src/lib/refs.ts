/**
 * The references in an agent's message: web links, Claude artifacts, a local dev server, and paths to
 * markdown and image files in the worktree. The chat shows each one as a chip that opens it in the
 * side viewer.
 */

export type RefKind = 'link' | 'artifact' | 'browser' | 'md' | 'image';
export type Ref = { kind: RefKind; target: string; label: string };

// No `*`, `[` or `]` in a URL here: they are markdown around it (bold, a link's text).
const URL_RE = /https?:\/\/[^\s<>`'"*[\]]+/gi;
const PATH_RE = /(^|[\s`'"(\[])((?:\.\/)?(?:[\w.@-]+\/)*[\w.@-]+\.(md|markdown|png|jpe?g|gif|webp|svg))(?=$|[\s`'")\],;:!?.])/gi;
const TRAIL = /[.,;:!?)\]'"_]$/;
const LOCAL = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]']);

/** Punctuation after a URL is not part of it. A `)` stays when the URL opened it: Foo_(bar). */
function trimUrl(raw: string): string {
  let s = raw;
  while (TRAIL.test(s)) {
    if (s.endsWith(')') && (s.match(/\(/g)?.length ?? 0) >= (s.match(/\)/g)?.length ?? 0)) break;
    s = s.slice(0, -1);
  }
  return s;
}

function urlRef(raw: string): Ref | null {
  // 0.0.0.0 is where a server listens, not where a browser goes (Chrome blocks frames to it).
  const target = trimUrl(raw).replace(/^(https?:\/\/)0\.0\.0\.0(?=[:/]|$)/i, '$1localhost');
  let u: URL;
  try {
    u = new URL(target);
  } catch {
    return null;
  }
  const label = (u.host + u.pathname + u.search).replace(/\/$/, '');
  if (LOCAL.has(u.hostname)) return { kind: 'browser', target, label };
  if (u.hostname === 'claude.ai' && /^\/(code\/)?artifact\//.test(u.pathname)) return { kind: 'artifact', target, label };
  return { kind: 'link', target, label };
}

/**
 * The references in a message. With the worktree's path, an absolute path inside it counts too (agents
 * often print those); it becomes relative to the worktree.
 */
export function findRefs(text: string, worktree?: string | null): Ref[] {
  if (worktree) {
    const root = worktree.replace(/\/+$/, '');
    // macOS shows /tmp and /var through /private as well.
    for (const r of root.startsWith('/private/') ? [root, root.slice('/private'.length)] : [`/private${root}`, root]) text = text.split(`${r}/`).join('');
  }
  const hits: { at: number; ref: Ref }[] = [];
  // Blank out the URLs first, so a path inside a URL is not found again as a file.
  const rest = text.replace(URL_RE, (raw, at: number) => {
    const ref = urlRef(raw);
    if (ref) hits.push({ at, ref });
    return ' '.repeat(raw.length);
  });
  for (const m of rest.matchAll(PATH_RE)) {
    const target = m[2].replace(/^\.\//, '');
    if (target.split('/').includes('..')) continue;
    const ext = m[3].toLowerCase();
    hits.push({ at: (m.index ?? 0) + m[1].length, ref: { kind: ext === 'md' || ext === 'markdown' ? 'md' : 'image', target, label: target.split('/').pop() ?? target } });
  }
  const seen = new Set<string>();
  return hits
    .sort((a, b) => a.at - b.at)
    .map((h) => h.ref)
    .filter((r) => !seen.has(r.target) && !!seen.add(r.target));
}

/** The viewer tab a reference opens. */
export function refTab(ref: Ref): string {
  return ref.kind === 'md' || ref.kind === 'image' ? `file:${ref.target}` : `link:${ref.target}`;
}
