import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { git, mainCheckout } from './merge.ts';

export interface CleanupResult {
  /** removed = the worktree is gone. refused = nothing changed; the text says why. */
  outcome: 'removed' | 'refused';
  text: string;
}

/**
 * Remove a task's worktree when the task is over. Nothing that is not saved somewhere else is lost
 * unless you pass `force`:
 * - Uncommitted changes stop the cleanup. `force` removes them.
 * - The branch is deleted only when the checked-out branch of the repository already holds all its
 *   commits (`git branch -d`). Otherwise the branch stays, so its commits stay.
 * - A scratch repository (a task with no repo) holds the only copy of the work, so it needs `force`.
 */
export function cleanupWorktree(worktree: string | null, opts: { force?: boolean } = {}): CleanupResult {
  if (!worktree || !existsSync(worktree)) return { outcome: 'removed', text: 'The worktree is already gone.' };
  if (!git(worktree, ['rev-parse', '--git-dir']).ok) {
    if (!opts.force) return { outcome: 'refused', text: `${worktree} is not a git repository. Clean up with force to delete the folder.` };
    rmSync(worktree, { recursive: true, force: true });
    return { outcome: 'removed', text: `Deleted ${worktree}.` };
  }

  const status = git(worktree, ['status', '--porcelain']);
  const dirty = status.ok && status.out ? status.out.split('\n').length : 0;
  const main = mainCheckout(worktree);
  const top = git(worktree, ['rev-parse', '--show-toplevel']);
  const scratch = !main.path || !top.ok || resolve(main.path) === resolve(top.out);

  if (scratch) {
    const commits = git(worktree, ['rev-list', '--count', 'HEAD']);
    const hasWork = dirty > 0 || (commits.ok && Number(commits.out) > 0);
    if (hasWork && !opts.force) {
      return { outcome: 'refused', text: `This task has its own scratch repository at ${worktree}. It holds the only copy of the work. Clean up with force to delete it.` };
    }
    rmSync(worktree, { recursive: true, force: true });
    return { outcome: 'removed', text: `Deleted the scratch repository at ${worktree}.` };
  }

  if (dirty && !opts.force) {
    return { outcome: 'refused', text: `The worktree has ${dirty} uncommitted ${dirty === 1 ? 'change' : 'changes'}. Commit them, or clean up with force to throw them away.` };
  }
  const branch = git(worktree, ['symbolic-ref', '--short', '-q', 'HEAD']);
  const removed = git(main.path!, ['worktree', 'remove', ...(opts.force ? ['--force'] : []), worktree]);
  if (!removed.ok) return { outcome: 'refused', text: `git did not remove the worktree. Nothing changed.\n${removed.out.split('\n').slice(0, 4).join('\n')}` };

  if (!branch.ok) return { outcome: 'removed', text: `Removed the worktree at ${worktree}.` };
  const name = branch.out;
  const merged = git(main.path!, ['merge-base', '--is-ancestor', name, 'HEAD']).ok;
  if (merged && git(main.path!, ['branch', '-d', name]).ok) {
    return { outcome: 'removed', text: `Removed the worktree at ${worktree} and the branch ${name}, which ${main.branch ?? 'HEAD'} already holds.` };
  }
  const ahead = git(main.path!, ['rev-list', '--count', `HEAD..${name}`]);
  return {
    outcome: 'removed',
    text: `Removed the worktree at ${worktree}. Kept the branch ${name}: it has ${ahead.ok ? ahead.out : 'some'} commits that ${main.branch ?? 'HEAD'} does not have.`,
  };
}
