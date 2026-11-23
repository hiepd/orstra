import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Git's empty tree: the base for a worktree whose whole history belongs to the task. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const MAX_DIFF_BYTES = 200_000;

export interface ChangedFile {
  path: string;
  /** A = added, M = modified, D = deleted, R = renamed */
  status: 'A' | 'M' | 'D' | 'R';
  add: number;
  del: number;
  /** Not committed yet (modified in the working tree, or untracked). */
  uncommitted: boolean;
}

export interface Commit {
  sha: string;
  message: string;
  ts: number;
}

export interface GitInfo {
  worktree: string;
  branch: string | null;
  /** The branch this work is compared with; null when the task has its own scratch repository. */
  base: string | null;
  ahead: number;
  uncommitted: number;
  files: ChangedFile[];
  commits: Commit[];
}

function git(dir: string, args: string[]): string | null {
  try {
    return execFileSync('git', ['-C', dir, ...args], { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).replace(/\n$/, '');
  } catch {
    return null;
  }
}

const lines = (s: string | null) => (s ? s.split('\n').filter(Boolean) : []);

/**
 * What the task's work is compared with. A git worktree off a repository compares with the commit it
 * branched from (the merge-base with the main checkout). A scratch folder compares with nothing.
 */
function baseOf(dir: string): { ref: string; name: string | null; hasCommits: boolean } {
  const head = git(dir, ['rev-parse', '--verify', '-q', 'HEAD']);
  if (!head) return { ref: EMPTY_TREE, name: null, hasCommits: false };
  const list = lines(git(dir, ['worktree', 'list', '--porcelain']));
  const mainPath = list.find((l) => l.startsWith('worktree '))?.slice('worktree '.length);
  const top = git(dir, ['rev-parse', '--show-toplevel']);
  if (!mainPath || !top || resolve(mainPath) === resolve(top)) return { ref: EMPTY_TREE, name: null, hasCommits: true };
  const mainHead = list.find((l) => l.startsWith('HEAD '))?.slice('HEAD '.length);
  const mainBranch = list.find((l) => l.startsWith('branch '))?.slice('branch refs/heads/'.length) ?? null;
  const base = mainHead ? git(dir, ['merge-base', 'HEAD', mainHead]) : null;
  return base ? { ref: base, name: mainBranch ?? 'main', hasCommits: true } : { ref: EMPTY_TREE, name: null, hasCommits: true };
}

function countLines(file: string): number {
  try {
    if (statSync(file).size > 2_000_000) return 0;
    const text = readFileSync(file, 'utf8');
    if (!text) return 0;
    return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  } catch {
    return 0;
  }
}

/** Branch, commits and changed files of a task's worktree, compared with where it started. */
export function gitInfo(dir: string): GitInfo | null {
  if (!existsSync(dir) || git(dir, ['rev-parse', '--git-dir']) === null) return null;
  const base = baseOf(dir);
  const branch = git(dir, ['symbolic-ref', '--short', '-q', 'HEAD']) ?? git(dir, ['rev-parse', '--short', 'HEAD']);

  const dirty = new Set<string>();
  const untracked: string[] = [];
  for (const l of lines(git(dir, ['status', '--porcelain', '--untracked-files=all']))) {
    const path = l.slice(3).replace(/^"|"$/g, '');
    dirty.add(path.includes(' -> ') ? path.split(' -> ')[1] : path);
    if (l.startsWith('??')) untracked.push(path);
  }

  const files = new Map<string, ChangedFile>();
  {
    const status = new Map<string, ChangedFile['status']>();
    for (const l of lines(git(dir, ['diff', '--name-status', '-M', base.ref]))) {
      const [code, a, b] = l.split('\t');
      status.set(b ?? a, (code[0] === 'R' ? 'R' : code[0] === 'A' ? 'A' : code[0] === 'D' ? 'D' : 'M') as ChangedFile['status']);
    }
    for (const l of lines(git(dir, ['diff', '--numstat', '-M', base.ref]))) {
      const [add, del, ...rest] = l.split('\t');
      const raw = rest.join('\t');
      const path = raw.includes(' => ') ? raw.replace(/\{.* => (.*)\}/, '$1').replace(/^.* => /, '') : raw;
      files.set(path, { path, status: status.get(path) ?? 'M', add: Number(add) || 0, del: Number(del) || 0, uncommitted: dirty.has(path) });
    }
  }
  for (const path of untracked) files.set(path, { path, status: 'A', add: countLines(join(dir, path)), del: 0, uncommitted: true });

  const range = base.ref === EMPTY_TREE ? ['HEAD'] : [`${base.ref}..HEAD`];
  const commits = base.hasCommits
    ? lines(git(dir, ['log', '--format=%h%x09%ct%x09%s', '-n', '50', ...range])).map((l) => {
        const [sha, ts, ...msg] = l.split('\t');
        return { sha, ts: Number(ts) * 1000, message: msg.join('\t') };
      })
    : [];
  const ahead = base.hasCommits ? Number(git(dir, ['rev-list', '--count', ...range]) ?? 0) : 0;

  return { worktree: dir, branch, base: base.name, ahead, uncommitted: dirty.size, files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)), commits };
}

/** One file's diff against the task's base, as unified diff text. */
export function gitDiff(dir: string, path: string): { path: string; diff: string; truncated: boolean } | null {
  if (!existsSync(dir) || git(dir, ['rev-parse', '--git-dir']) === null) return null;
  const abs = resolve(dir, path);
  if (!abs.startsWith(resolve(dir) + '/')) return null;
  const base = baseOf(dir);
  let diff = git(dir, ['diff', '-M', base.ref, '--', path]) ?? '';
  if (!diff && existsSync(abs)) {
    // Untracked file: show it as all-added.
    try {
      diff = execFileSync('git', ['-C', dir, 'diff', '--no-index', '--', '/dev/null', path], { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    } catch (err: any) {
      diff = typeof err?.stdout === 'string' ? err.stdout : ''; // exit code 1 just means "there are differences"
    }
  }
  const truncated = diff.length > MAX_DIFF_BYTES;
  return { path, diff: truncated ? diff.slice(0, MAX_DIFF_BYTES) : diff, truncated };
}
