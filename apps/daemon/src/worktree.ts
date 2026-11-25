import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { WORKTREES, expandHome } from './paths.ts';

/**
 * Give a task its own working copy. With a repo: a git worktree on branch orstra/<task>, started from
 * `base` when given, else from what the repo has checked out. Without one: an empty scratch folder
 * with git initialised, so agents can still work and diff.
 */
export function createWorktree(taskId: string, repo?: string, base?: string): string {
  const dir = join(WORKTREES, taskId);
  if (existsSync(dir)) return dir;
  if (repo) {
    const repoPath = expandHome(repo);
    execFileSync('git', ['-C', repoPath, 'worktree', 'add', '-q', dir, '-b', `orstra/${taskId}`, ...(base ? [base] : [])], { stdio: 'pipe' });
  } else {
    mkdirSync(dir, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, stdio: 'pipe' });
  }
  return dir;
}
