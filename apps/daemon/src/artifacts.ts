import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { ArtifactSpec } from '@orstra/core';
import { ARTIFACTS } from './paths.ts';

/**
 * Where any agent or gate step leaves a file to keep. No workflow change needed: whatever a run
 * writes here is collected, shown at the review and handed to the steps after it.
 */
export const ARTIFACT_DIR = '.orstra/artifacts';
/** Where the next run finds what the earlier steps kept: `.orstra/inputs/<step>/<file>`. */
export const INPUT_DIR = '.orstra/inputs';
/** The folder every agent and gate run is collected from, declared or not. */
export const DEFAULT_SPEC: ArtifactSpec = { name: 'artifacts', path: `${ARTIFACT_DIR}/**/*` };

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
export function matchArtifacts(worktree: string, specs: ArtifactSpec[], since = 0): { matches: Match[] } {
  const files = walk(worktree);
  const matches: Match[] = [];
  const taken = new Set<string>();
  for (const spec of specs) {
    const re = globToRegExp(spec.path);
    for (const f of files) {
      if (!re.test(f)) continue;
      let st;
      try {
        st = statSync(join(worktree, f));
      } catch {
        continue;
      }
      if (st.mtimeMs + 1000 < since) continue; // written before this run started
      if (taken.has(f)) continue; // 2 specs, 1 file: keep it once
      taken.add(f);
      matches.push({ from: f, spec, bytes: st.size });
    }
  }
  return { matches };
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
}

/** A file counts as already kept when the same name with the same bytes is in the store. */
export const seenKey = (name: string, sha: string): string => `${name}\0${sha}`;

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
  /** `seenKey` of every file this task already keeps. A file left unchanged in the folder is not kept twice. */
  seen?: Set<string>;
}): Collected {
  const { matches } = matchArtifacts(opts.worktree, opts.specs, opts.since ?? 0);
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
    let sha: string;
    try {
      sha = createHash('sha256').update(readFileSync(join(opts.worktree, m.from))).digest('hex');
    } catch {
      continue;
    }
    if (opts.seen?.has(seenKey(m.from.split('/').pop() || name, sha))) {
      used.delete(name);
      continue;
    }
    try {
      mkdirSync(dest, { recursive: true });
      copyFileSync(join(opts.worktree, m.from), to);
    } catch (err: any) {
      saved.push({ name, label: m.spec.name, mime, bytes: m.bytes, sha256: null, path: null, skipped: `could not be copied: ${err?.message ?? err}` });
      continue;
    }
    total += m.bytes;
    saved.push({ name, label: m.spec.name, mime, bytes: m.bytes, sha256: sha, path: to });
  }
  return { saved };
}

/** Where an earlier step's file appears for the runs after it. */
export const inputPath = (stepId: string, name: string): string => `${INPUT_DIR}/${stepId}/${name}`;

export interface Input {
  stepId: string;
  name: string;
  /** The stored copy, outside the worktree. */
  from: string;
}

/**
 * Put the earlier steps' artifacts where the next run can read them: `.orstra/inputs/<step>/<file>`,
 * inside the worktree, so any agent or gate command opens them with a relative path and no
 * permission question. The folder is rebuilt for every run, so it always holds the latest kept copy.
 */
export function stageInputs(worktree: string, inputs: Input[]): string[] {
  const root = join(worktree, INPUT_DIR);
  rmSync(root, { recursive: true, force: true });
  const placed: string[] = [];
  let total = 0;
  for (const i of inputs) {
    let size = 0;
    try {
      size = statSync(i.from).size;
    } catch {
      continue; // the stored copy is gone
    }
    if (total + size > MAX_RUN_BYTES) continue;
    const rel = inputPath(i.stepId, i.name);
    try {
      mkdirSync(join(worktree, INPUT_DIR, i.stepId), { recursive: true });
      copyFileSync(i.from, join(worktree, rel));
    } catch {
      continue;
    }
    total += size;
    placed.push(rel);
  }
  return placed;
}
