import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * merged = the main branch moved. nothing = there was nothing to merge, and no repository changed.
 * conflict = the merge was undone and the repository is as it was. error = the merge never started.
 */
export type MergeOutcome = 'merged' | 'nothing' | 'conflict' | 'error';

export interface MergeResult {
  outcome: MergeOutcome;
  /** One or two sentences for the task's history. Says what happened and what is left to do. */
  text: string;
  /** The task's branch, when it has one. */
  branch?: string;
  /** The branch that was merged into, when there is one. */
  target?: string;
  /** The main checkout of the repository, when the task worktree belongs to one. */
  main?: string;
}

/** Run git and keep its output. Never opens an editor and never asks for a password. */
function git(dir: string, args: string[]): { ok: boolean; out: string } {
  try {
    const out = execFileSync('git', ['-C', dir, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, GIT_EDITOR: 'true', GIT_TERMINAL_PROMPT: '0' },
    });
    return { ok: true, out: out.replace(/\n+$/, '') };
  } catch (err: any) {
    const out = `${typeof err?.stdout === 'string' ? err.stdout : ''}${typeof err?.stderr === 'string' ? err.stderr : ''}`.trim();
    return { ok: false, out };
  }
}

/** The main checkout of the repository the worktree belongs to: the first block of `worktree list`. */
function mainCheckout(dir: string): { path: string | null; branch: string | null } {
  const porcelain = git(dir, ['worktree', 'list', '--porcelain']);
  if (!porcelain.ok) return { path: null, branch: null };
  const block = porcelain.out.split(/\n\s*\n/)[0].split('\n');
  const line = (p: string) => block.find((l) => l.startsWith(p))?.slice(p.length) ?? null;
  const branch = line('branch refs/heads/');
  return { path: line('worktree '), branch };
}

const first = (s: string, n = 6) => s.split('\n').slice(0, n).join('\n');

/**
 * Merge a task's branch into the branch its repository has checked out, in the local repository only.
 *
 * Nothing is ever forced and nothing is pushed. The merge runs only when the main checkout is clean,
 * so `git merge --abort` can put the repository back exactly as it was if the merge conflicts.
 * The task worktree and its branch are kept: the task's review panel reads them, and removing them
 * would throw away any work the agent did not commit.
 */
export function mergeTaskBranch(worktree: string): MergeResult {
  if (!worktree || !existsSync(worktree)) {
    return { outcome: 'nothing', text: 'Nothing to merge: this task has no worktree on disk.' };
  }
  if (!git(worktree, ['rev-parse', '--git-dir']).ok) {
    return { outcome: 'nothing', text: 'Nothing to merge: the task worktree is not a git repository.' };
  }
  if (!git(worktree, ['rev-parse', '--verify', '-q', 'HEAD']).ok) {
    return { outcome: 'nothing', text: 'Nothing to merge: the task branch holds no commits.' };
  }

  const main = mainCheckout(worktree);
  const top = git(worktree, ['rev-parse', '--show-toplevel']);
  if (!main.path || !top.ok || resolve(main.path) === resolve(top.out)) {
    return { outcome: 'nothing', text: 'Nothing to merge: this task has its own scratch repository, so there is no main checkout to merge into.' };
  }

  const head = git(worktree, ['symbolic-ref', '--short', '-q', 'HEAD']);
  if (!head.ok) {
    return { outcome: 'error', main: main.path, text: 'The task worktree is not on a branch (detached HEAD), so there is nothing to merge by name. Nothing changed.' };
  }
  const branch = head.out;
  if (!main.branch) {
    return { outcome: 'error', branch, main: main.path, text: `The main checkout at ${main.path} is not on a branch, so there is no merge target. Nothing changed.` };
  }
  const target = main.branch;
  const where = { branch, target, main: main.path };

  const ahead = git(worktree, ['rev-list', '--count', `${target}..HEAD`]);
  if (ahead.ok && Number(ahead.out) === 0) {
    return { outcome: 'nothing', ...where, text: `Nothing to merge: ${branch} has no commits that ${target} does not have. ${target} is unchanged.` };
  }

  // A clean main checkout is what makes `git merge --abort` able to undo a conflicted merge in full.
  const dirty = git(main.path, ['status', '--porcelain', '--untracked-files=no']);
  if (!dirty.ok) {
    return { outcome: 'error', ...where, text: `Could not read the state of the main checkout at ${main.path}. Nothing was merged.\n${first(dirty.out)}` };
  }
  if (dirty.out) {
    const n = dirty.out.split('\n').length;
    return {
      outcome: 'error',
      ...where,
      text: `Did not merge ${branch} into ${target}: the main checkout at ${main.path} has ${n} uncommitted ${n === 1 ? 'file' : 'files'}. A merge there could mix your work with the task's. Commit or stash them, then re-run this step.`,
    };
  }
  if (git(main.path, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).ok) {
    return { outcome: 'error', ...where, text: `Did not merge ${branch} into ${target}: a merge is already in progress in ${main.path}. Finish or abort it, then re-run this step.` };
  }

  const merge = git(main.path, ['merge', '--no-edit', branch]);
  if (merge.ok) {
    return {
      outcome: 'merged',
      ...where,
      text: `Merged ${branch} into ${target} in ${main.path}. Nothing was pushed. The worktree at ${worktree} and the branch ${branch} stay as they are.\n${first(merge.out, 3)}`,
    };
  }

  // The merge failed. If git started it, undo it; if git refused to start, the repository never changed.
  const started = git(main.path, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).ok;
  if (!started) {
    return { outcome: 'error', ...where, text: `git refused to merge ${branch} into ${target}, so nothing changed in ${main.path}.\n${first(merge.out)}` };
  }
  const conflicts = git(main.path, ['diff', '--name-only', '--diff-filter=U']);
  const names = conflicts.ok && conflicts.out ? conflicts.out.split('\n') : [];
  const abort = git(main.path, ['merge', '--abort']);
  const after = git(main.path, ['status', '--porcelain', '--untracked-files=no']);
  const clean = abort.ok && after.ok && !after.out && !git(main.path, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).ok;
  const listed = names.length ? ` Conflicts in: ${names.slice(0, 10).join(', ')}${names.length > 10 ? `, and ${names.length - 10} more` : ''}.` : '';
  if (!clean) {
    return {
      outcome: 'error',
      ...where,
      text: `The merge of ${branch} into ${target} conflicted, and the undo failed. The main checkout at ${main.path} is mid-merge. Fix it by hand: run "git merge --abort" there.${listed}`,
    };
  }
  return {
    outcome: 'conflict',
    ...where,
    text: `${branch} does not merge into ${target} on its own.${listed} The merge is undone and ${main.path} is as it was. Merge it by hand, or send the task back for more changes.`,
  };
}
