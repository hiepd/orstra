import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { ArtifactSpec } from '@orstra/core';
import { ARTIFACTS } from './paths.ts';

/** Bigger than this and Orstra records the gap instead of the file. */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_RUN_BYTES = 50 * 1024 * 1024;
/** Folders a glob never reaches, and how deep the walk goes. */
const SKIP_DIRS = new Set(['.git', 'node_modules', '.next', 'dist', '.venv', '__pycache__']);
const MAX_DEPTH = 10;
const MAX_FILES = 20_000;

const MIMES: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.txt': 'text/plain', '.log': 'text/plain', '.md': 'text/markdown',
  '.json': 'application/json', '.html': 'text/html', '.csv': 'text/csv', '.xml': 'application/xml',
  '.pdf': 'application/pdf', '.zip': 'application/zip', '.mp4': 'video/mp4', '.webm': 'video/webm',
};

export const mimeOf = (path: string): string => MIMES[extname(path).toLowerCase()] ?? 'application/octet-stream';

/** How the review shows it: inline picture, inline text, or a download. */
export function kindOf(mime: string): 'image' | 'text' | 'file' {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('text/') || mime === 'application/json' || mime === 'application/xml') return 'text';
  return 'file';
}

/**
 * A glob over worktree-relative paths. `*` and `?` stay inside one segment; `**` crosses folders.
 * Small on purpose: a workflow file declares a path, not a pattern language.
 */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') i++;
      re += '(?:[^/]+/)*';
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** Every file under `dir`, as paths relative to it, with the heavy folders left out. */
function walk(dir: string, prefix = '', depth = 0, out: string[] = []): string[] {
  if (depth > MAX_DEPTH || out.length >= MAX_FILES) return out;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (out.length >= MAX_FILES) return out;
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(join(dir, e.name), `${prefix}${e.name}/`, depth + 1, out);
    } else if (e.isFile()) out.push(prefix + e.name);
  }
  return out;
}

export interface Match {
  /** Path inside the worktree. */
  from: string;
  spec: ArtifactSpec;
  bytes: number;
}

/**
 * Files in the worktree that the specs ask for. `since` keeps out files an earlier run left behind:
 * only what this run wrote counts as its own.
 */
export function matchArtifacts(worktree: string, specs: ArtifactSpec[], since = 0): { matches: Match[]; missing: ArtifactSpec[] } {
  const files = walk(worktree);
  const matches: Match[] = [];
  const missing: ArtifactSpec[] = [];
  const taken = new Set<string>();
  for (const spec of specs) {
    const re = globToRegExp(spec.path);
    let hit = 0;
    for (const f of files) {
      if (!re.test(f)) continue;
      let st;
      try {
        st = statSync(join(worktree, f));
      } catch {
        continue;
      }
      if (st.mtimeMs + 1000 < since) continue; // written before this run started
      hit++;
      if (taken.has(f)) continue; // 2 specs, 1 file: keep it once
      taken.add(f);
      matches.push({ from: f, spec, bytes: st.size });
    }
    if (hit === 0) missing.push(spec);
  }
  return { matches, missing };
}

export interface Saved {
  /** File name in the store folder. */
  name: string;
  label: string;
  mime: string;
  bytes: number;
  sha256: string | null;
  /** Absolute path in the store, null when Orstra skipped the file. */
  path: string | null;
  /** Set when Orstra skipped it. */
  skipped?: string;
}

export interface Collected {
  saved: Saved[];
  /** Specs that matched nothing. */
  missing: ArtifactSpec[];
}

const unique = (used: Set<string>, name: string): string => {
  if (!used.has(name)) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 2; ; i++) if (!used.has(`${stem}-${i}${ext}`)) return `${stem}-${i}${ext}`;
};

/**
 * Copy what a run produced out of its worktree into the store, so it outlives the worktree.
 * Over a cap, the file is left where it is and the gap is recorded in its place.
 */
export function collectArtifacts(opts: {
  worktree: string;
  specs: ArtifactSpec[];
  taskId: string;
  runId: string;
  since?: number;
  root?: string;
}): Collected {
  const { matches, missing } = matchArtifacts(opts.worktree, opts.specs, opts.since ?? 0);
  const dest = join(opts.root ?? ARTIFACTS, opts.taskId, opts.runId);
  const saved: Saved[] = [];
  const used = new Set<string>();
  let total = 0;

  for (const m of matches) {
    const name = unique(used, m.from.split('/').pop() || 'artifact');
    used.add(name);
    const mime = mimeOf(m.from);
    if (m.bytes > MAX_FILE_BYTES) {
      saved.push({ name, label: m.spec.name, mime, bytes: m.bytes, sha256: null, path: null, skipped: `over the ${MAX_FILE_BYTES / 1024 / 1024} MB cap per file` });
      continue;
    }
    if (total + m.bytes > MAX_RUN_BYTES) {
      saved.push({ name, label: m.spec.name, mime, bytes: m.bytes, sha256: null, path: null, skipped: `over the ${MAX_RUN_BYTES / 1024 / 1024} MB cap per run` });
      continue;
    }
    const to = join(dest, name);
    try {
      mkdirSync(dest, { recursive: true });
      copyFileSync(join(opts.worktree, m.from), to);
    } catch (err: any) {
      saved.push({ name, label: m.spec.name, mime, bytes: m.bytes, sha256: null, path: null, skipped: `could not be copied: ${err?.message ?? err}` });
      continue;
    }
    total += m.bytes;
    saved.push({ name, label: m.spec.name, mime, bytes: m.bytes, sha256: createHash('sha256').update(readFileSync(to)).digest('hex'), path: to });
  }
  return { saved, missing };
}
