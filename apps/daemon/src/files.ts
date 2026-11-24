import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute, resolve, sep } from 'node:path';

/**
 * The side viewer reads the task's worktree: the list of its files, and one file's bytes.
 *
 * A path comes from the browser, so it is untrusted. A read stays inside the worktree after the real
 * path is resolved, so neither `..` nor a symlink gets out.
 */

/** The largest file the viewer reads. */
export const MAX_VIEW_BYTES = 10 * 1024 * 1024;
/** The most paths the Files panel gets. */
export const MAX_LIST = 5000;

const TEXT = 'text/plain; charset=utf-8';
const MIME: Record<string, string> = {
  '.md': 'text/markdown; charset=utf-8', '.markdown': 'text/markdown; charset=utf-8',
  '.txt': TEXT, '.json': 'application/json; charset=utf-8', '.yaml': TEXT, '.yml': TEXT,
  '.ts': TEXT, '.tsx': TEXT, '.js': TEXT, '.jsx': TEXT, '.mjs': TEXT, '.css': TEXT, '.py': TEXT, '.sh': TEXT, '.toml': TEXT,
  // HTML shows as text: a page from the worktree must never run in Orstra's origin.
  '.html': TEXT, '.htm': TEXT,
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
};

export function mimeOf(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

/** Tracked and untracked files, without the ones .gitignore leaves out, sorted. */
export function listFiles(worktree: string): { paths: string[]; truncated: boolean } {
  const out = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: worktree, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const all = [...new Set(out.split('\0').filter(Boolean))].sort();
  return { paths: all.slice(0, MAX_LIST), truncated: all.length > MAX_LIST };
}

/** One file's bytes, or null when it is missing, too large, not a file, or not in the worktree. */
export function readWorktreeFile(worktree: string, rel: string): { body: Buffer; mime: string; name: string } | null {
  if (!rel || isAbsolute(rel) || rel.includes('\0')) return null;
  try {
    const root = realpathSync(worktree);
    const target = realpathSync(resolve(root, rel));
    if (!target.startsWith(root + sep)) return null;
    const st = statSync(target);
    if (!st.isFile() || st.size > MAX_VIEW_BYTES) return null;
    return { body: readFileSync(target), mime: mimeOf(target), name: basename(target) };
  } catch {
    return null;
  }
}
