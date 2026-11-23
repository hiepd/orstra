import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const HOME = process.env.ORSTRA_HOME ?? join(homedir(), '.orstra');
export const DB_PATH = join(HOME, 'orstra.db');
/** Which daemon owns this home folder. See lock.ts. */
export const LOCK_PATH = join(HOME, 'daemon.lock');
export const WORKTREES = join(HOME, 'wt');
/** Files a run produced, copied out of the worktree so they outlive it. */
export const ARTIFACTS = join(HOME, 'artifacts');
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
  mkdirSync(ARTIFACTS, { recursive: true });
  // First run: seed the workflow folder from the repo's defaults. After that it is the user's, never touched.
  const firstRun = !existsSync(WORKFLOWS_DIR);
  mkdirSync(WORKFLOWS_DIR, { recursive: true });
  if (firstRun && existsSync(SEED_WORKFLOWS)) cpSync(SEED_WORKFLOWS, WORKFLOWS_DIR, { recursive: true });
  mkdirSync(COS_DIR, { recursive: true });
}

export function expandHome(p: string): string {
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
}
