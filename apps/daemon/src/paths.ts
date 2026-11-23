import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const HOME = process.env.ORSTRA_HOME ?? join(homedir(), '.orstra');
export const DB_PATH = join(HOME, 'orstra.db');
export const WORKTREES = join(HOME, 'wt');
export const REPO_ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
/** Workflows are user config, not repo files. Override the folder with ORSTRA_WORKFLOWS. */
export const WORKFLOWS_DIR = process.env.ORSTRA_WORKFLOWS ?? join(HOME, 'workflows');
/** Default workflows shipped in the repo, copied into WORKFLOWS_DIR on first run. */
export const SEED_WORKFLOWS = join(REPO_ROOT, 'workflows');
export const WORKFLOW_DIRS = [WORKFLOWS_DIR];
export const WEB_DIST = join(REPO_ROOT, 'apps/web/dist');
export const PORT = Number(process.env.ORSTRA_PORT ?? 4317);
export const SLOTS = Number(process.env.ORSTRA_SLOTS ?? 4);
/** Where the chief of staff's Claude Code session runs; this keeps its own notes out of any repo. */
export const COS_DIR = join(HOME, 'cos');
export const TSX = join(REPO_ROOT, 'node_modules/.bin/tsx');

export function ensureDirs() {
  mkdirSync(HOME, { recursive: true });
  mkdirSync(WORKTREES, { recursive: true });
  // First run: seed the workflow folder from the repo's defaults. After that it is the user's, never touched.
  const firstRun = !existsSync(WORKFLOWS_DIR);
  mkdirSync(WORKFLOWS_DIR, { recursive: true });
  if (firstRun && existsSync(SEED_WORKFLOWS)) cpSync(SEED_WORKFLOWS, WORKFLOWS_DIR, { recursive: true });
  mkdirSync(COS_DIR, { recursive: true });
}

export function expandHome(p: string): string {
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
}

/**
 * The repository behind each task worktree. A linked worktree's `.git` is a file that reads
 * `gitdir: <repo>/.git/worktrees/<task>`, so the repository root needs no git process to find.
 * A task with its own scratch repository has a real `.git` folder and adds nothing here.
 */
export function worktreeRepos(dir: string = WORKTREES): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const gitFile = join(dir, name, '.git');
    try {
      if (!statSync(gitFile).isFile()) continue;
      const m = readFileSync(gitFile, 'utf8').match(/^gitdir:\s*(.+?)\/\.git\/worktrees\//m);
      if (m) out.push(resolve(m[1]));
    } catch {
      // Not a worktree we can read; skip it.
    }
  }
  return out;
}

/**
 * The chief of staff's working folders, next to COS_DIR, which its session runs in. Its file tools reach
 * other paths too (every tool it has is approved up front), so these are the folders it works in, not a
 * fence: a relative path, Glob and Grep work in them, and Claude Code reads their CLAUDE.md.
 * - HOME: the database, the workflow files, and every task worktree under `wt/`.
 * - REPO_ROOT: the Orstra checkout the daemon runs from.
 * - the repository behind each task worktree, so it can compare a task's branch with its repository.
 * - ORSTRA_COS_DIRS: more folders, separated like PATH, for a repository no worktree points at yet.
 */
export function cosDirs(): string[] {
  const extra = (process.env.ORSTRA_COS_DIRS ?? '')
    .split(delimiter)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => resolve(expandHome(p)));
  // HOME and REPO_ROOT always exist when the daemon serves (see ensureDirs); the rest may not.
  const all = [...new Set([HOME, REPO_ROOT, ...[...worktreeRepos(), ...extra].filter((d) => existsSync(d))])];
  // Drop a folder that another one already covers.
  return all.filter((d) => !all.some((o) => o !== d && d.startsWith(o + '/')));
}
