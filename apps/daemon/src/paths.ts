import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const HOME = process.env.ORSTRA_HOME ?? join(homedir(), '.orstra');
export const DB_PATH = join(HOME, 'orstra.db');
export const WORKTREES = join(HOME, 'wt');
export const REPO_ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
export const WORKFLOW_DIRS = [join(REPO_ROOT, 'workflows'), join(HOME, 'workflows')];
export const WEB_DIST = join(REPO_ROOT, 'apps/web/dist');
export const PORT = Number(process.env.ORSTRA_PORT ?? 4317);
export const SLOTS = Number(process.env.ORSTRA_SLOTS ?? 4);
/** Where the chief of staff's Claude Code session runs (it has no files to work on; this keeps it out of any repo). */
export const COS_DIR = join(HOME, 'cos');
export const TSX = join(REPO_ROOT, 'node_modules/.bin/tsx');

export function ensureDirs() {
  mkdirSync(HOME, { recursive: true });
  mkdirSync(WORKTREES, { recursive: true });
  mkdirSync(join(HOME, 'workflows'), { recursive: true });
  mkdirSync(COS_DIR, { recursive: true });
}

export function expandHome(p: string): string {
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
}
