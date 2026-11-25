import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, statSync } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';
import type { Store, TaskRow, WorkspaceRow } from './db.ts';
import { expandHome } from './paths.ts';

/**
 * A workspace says where a task's code is: 1 repo, the branch a new task starts from, an optional
 * folder inside the repo where agents start, and how to prepare a fresh worktree. Every task you
 * start names one, so no agent opens an empty folder again.
 */

/** A workspace as the API and the UI see it: its JSON columns parsed. */
export interface WorkspaceView {
  id: string;
  name: string;
  repoPath: string;
  baseBranch: string;
  subdir: string;
  defaultWorkflow: string | null;
  setup: string[];
  copyFiles: string[];
  env: Record<string, string>;
  createdAt: number;
  updatedAt: number;
}

/** What you send to create or change a workspace. Every field is optional on a change. */
export interface WorkspaceInput {
  name?: string;
  repoPath?: string;
  baseBranch?: string;
  subdir?: string;
  defaultWorkflow?: string | null;
  setup?: string[];
  copyFiles?: string[];
  env?: Record<string, string>;
}

export class WorkspaceError extends Error {}

function git(dir: string, args: string[]): string | null {
  try {
    return execFileSync('git', ['-C', dir, ...args], { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function parse<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

export function workspaceView(w: WorkspaceRow): WorkspaceView {
  return {
    id: w.id, name: w.name, repoPath: w.repo_path, baseBranch: w.base_branch, subdir: w.subdir, defaultWorkflow: w.default_workflow,
    setup: parse<string[]>(w.setup, []), copyFiles: parse<string[]>(w.copy_files, []), env: parse<Record<string, string>>(w.env, {}),
    createdAt: w.created_at, updatedAt: w.updated_at,
  };
}

/** The branch a repo's remote points at (origin/HEAD), else the branch it has checked out, else main. */
export function defaultBranch(repo: string): string {
  const remote = git(repo, ['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD']);
  if (remote) return remote.replace(/^origin\//, '');
  return git(repo, ['symbolic-ref', '-q', '--short', 'HEAD']) ?? 'main';
}

/** A path inside the repo, written relative to its root: no `..`, not absolute. '' is the root. */
export function cleanRelative(p: string, what: string): string {
  const t = p.trim().replace(/^\.\/+/, '').replace(/\/+$/, '');
  if (!t || t === '.') return '';
  const n = normalize(t);
  if (isAbsolute(n) || n === '..' || n.startsWith('../')) throw new WorkspaceError(`${what} must be a path inside the repo, such as apps/web.`);
  return n;
}

/** Check a workspace's fields against the disk, and give back the row values to store. */
function checked(input: Required<Pick<WorkspaceInput, 'name' | 'repoPath'>> & WorkspaceInput) {
  const name = input.name.trim();
  if (!name) throw new WorkspaceError('A workspace needs a name.');
  const repoPath = input.repoPath.trim();
  if (!repoPath) throw new WorkspaceError('A workspace needs a repo path.');
  const repo = expandHome(repoPath);
  if (!existsSync(repo) || git(repo, ['rev-parse', '--git-dir']) === null) throw new WorkspaceError(`${repoPath} is not a git repository.`);
  if (git(repo, ['rev-parse', '--verify', '-q', 'HEAD']) === null) throw new WorkspaceError(`${repoPath} has no commits yet. Make a first commit, then add it.`);
  const baseBranch = input.baseBranch?.trim() || defaultBranch(repo);
  if (git(repo, ['rev-parse', '--verify', '-q', `${baseBranch}^{commit}`]) === null) throw new WorkspaceError(`${repoPath} has no branch called ${baseBranch}.`);
  const subdir = cleanRelative(input.subdir ?? '', 'The sub-directory');
  if (subdir && !(existsSync(join(repo, subdir)) && statSync(join(repo, subdir)).isDirectory())) throw new WorkspaceError(`${repoPath} has no folder called ${subdir}.`);
  const copyFiles = (input.copyFiles ?? []).map((f) => cleanRelative(f, 'A file to copy')).filter(Boolean);
  const setup = (input.setup ?? []).map((c) => c.trim()).filter(Boolean);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.env ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new WorkspaceError(`"${k}" is not a valid environment variable name.`);
    env[k] = String(v);
  }
  return {
    name, repo_path: repoPath, base_branch: baseBranch, subdir, default_workflow: input.defaultWorkflow?.trim() || null,
    setup: JSON.stringify(setup), copy_files: JSON.stringify(copyFiles), env: JSON.stringify(env),
  };
}

function sameName(store: Store, name: string, except?: string) {
  const hit = store.workspaces().find((w) => w.name.toLowerCase() === name.toLowerCase() && w.id !== except);
  if (hit) throw new WorkspaceError(`A workspace called ${hit.name} already exists.`);
}

export function createWorkspace(store: Store, input: WorkspaceInput): WorkspaceRow {
  const values = checked({ ...input, name: input.name ?? '', repoPath: input.repoPath ?? '' });
  sameName(store, values.name);
  const now = Date.now();
  const row: WorkspaceRow = { id: `w-${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`, ...values, created_at: now, updated_at: now };
  store.insertWorkspace(row);
  return row;
}

export function updateWorkspace(store: Store, id: string, input: WorkspaceInput): WorkspaceRow {
  const w = store.workspace(id);
  if (!w) throw new WorkspaceError('No such workspace.');
  const now = workspaceView(w);
  const values = checked({
    name: input.name ?? now.name, repoPath: input.repoPath ?? now.repoPath, baseBranch: input.baseBranch ?? now.baseBranch,
    subdir: input.subdir ?? now.subdir, defaultWorkflow: input.defaultWorkflow === undefined ? now.defaultWorkflow : input.defaultWorkflow,
    setup: input.setup ?? now.setup, copyFiles: input.copyFiles ?? now.copyFiles, env: input.env ?? now.env,
  });
  sameName(store, values.name, id);
  store.updateWorkspace(id, values);
  return store.workspace(id)!;
}

/** Remove a workspace. Its tasks keep their worktrees and branches; they only lose the link. */
export function deleteWorkspace(store: Store, id: string): number {
  if (!store.workspace(id)) throw new WorkspaceError('No such workspace.');
  const tasks = store.tasks().filter((t) => t.workspace_id === id);
  for (const t of tasks) store.updateTask(t.id, { workspace_id: null });
  store.deleteWorkspace(id);
  return tasks.length;
}

/** A workspace by id or by name, as the assistant or the CLI names it. */
export function findWorkspace(store: Store, ref: string): WorkspaceRow | undefined {
  const r = ref.trim().toLowerCase();
  return store.workspaces().find((w) => w.id === ref.trim() || w.name.toLowerCase() === r);
}

/**
 * Which workspace a new task gets. Named → that one. A bare repo path → none (the task uses the path
 * once). Nothing named and exactly 1 workspace → that one. Otherwise the start is refused, because a
 * task with no repo gets an empty folder and its agent stops.
 */
export function pickWorkspace(store: Store, input: { workspace?: string; repo?: string }): WorkspaceRow | null {
  if (input.workspace) {
    const w = findWorkspace(store, input.workspace);
    if (!w) throw new WorkspaceError(`There is no workspace called ${input.workspace}.`);
    return w;
  }
  if (input.repo) return null;
  const all = store.workspaces();
  if (all.length === 1) return all[0];
  if (all.length === 0) throw new WorkspaceError('A task needs a workspace. Add one on the Workspaces page, or give a repo path for this task.');
  throw new WorkspaceError(`A task needs a workspace. Pick one of: ${all.map((w) => w.name).join(', ')}.`);
}

/**
 * Copy the workspace's gitignored files (such as .env.local) from the repo into a new worktree.
 * Returns what it copied and what the repo did not have.
 */
export function copyIntoWorktree(repoPath: string, worktree: string, files: string[]): { copied: string[]; missing: string[] } {
  const repo = expandHome(repoPath);
  const copied: string[] = [];
  const missing: string[] = [];
  for (const f of files) {
    const from = join(repo, f);
    if (!existsSync(from)) {
      missing.push(f);
      continue;
    }
    cpSync(from, join(worktree, f), { recursive: true, force: true });
    copied.push(f);
  }
  return { copied, missing };
}

/** Where a task's agents and gates start: the worktree, or the workspace's folder inside it. */
export function taskCwd(task: Pick<TaskRow, 'worktree' | 'subdir'>): string {
  if (!task.worktree) return process.cwd();
  return task.subdir ? join(task.worktree, task.subdir) : task.worktree;
}
