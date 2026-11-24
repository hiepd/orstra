import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

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

/** What the steps made. Orstra keeps .orstra/ out of git (.git/info/exclude), so git does not list it. */
const ARTIFACTS = '.orstra/artifacts';

function walk(root: string, rel: string, out: string[], cap: number) {
  let entries;
  try {
    entries = readdirSync(resolve(root, rel), { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (out.length >= cap) return;
    const p = `${rel}/${e.name}`;
    if (e.isDirectory()) walk(root, p, out, cap);
    else if (e.isFile()) out.push(p);
  }
}

/** Tracked and untracked files, without the ones .gitignore leaves out, plus .orstra/artifacts, sorted. */
export function listFiles(worktree: string): { paths: string[]; truncated: boolean } {
  const out = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: worktree, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const made: string[] = [];
  walk(worktree, ARTIFACTS, made, MAX_LIST);
  const all = [...new Set([...out.split('\0').filter(Boolean), ...made])].sort();
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

/** The most repositories, besides the worktree, that one task's file reads may use. */
const MAX_ROOTS = 10;

/**
 * The git repositories that hold the files an agent read or edited, from the absolute paths in its tool
 * calls. An agent can work outside its worktree (a task with no repo gets an empty scratch folder,
 * and the agent then works in a checkout you named). The viewer may read files there too.
 * Your home folder and / never count, even when they are repositories.
 */
export function agentRoots(paths: string[]): string[] {
  const roots: string[] = [];
  const home = resolve(homedir());
  for (const p of paths) {
    if (!isAbsolute(p) || roots.length >= MAX_ROOTS) continue;
    for (let d = dirname(p); d !== dirname(d); d = dirname(d)) {
      if (!existsSync(join(d, '.git'))) continue;
      if (d !== home && !roots.includes(d)) roots.push(d);
      break;
    }
  }
  return roots;
}

/**
 * One file for the viewer: a relative path from the first root that has it (the worktree comes first),
 * an absolute path only when it is inside one of the roots. Null otherwise.
 */
export function readTaskFile(roots: string[], path: string): { body: Buffer; mime: string; name: string } | null {
  if (!isAbsolute(path)) {
    for (const r of roots) {
      const hit = readWorktreeFile(r, path);
      if (hit) return hit;
    }
    return null;
  }
  let target: string;
  try {
    target = realpathSync(path);
  } catch {
    return null;
  }
  for (const r of roots) {
    try {
      const rr = realpathSync(r);
      if (target.startsWith(rr + sep)) return readWorktreeFile(r, relative(rr, target));
    } catch {
      /* a root that is gone */
    }
  }
  return null;
}
