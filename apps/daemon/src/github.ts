import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { git, mainCheckout } from './merge.ts';

export interface PrResult {
  /** opened = a new pull request. exists = one was already open for the branch. */
  outcome: 'opened' | 'exists' | 'nothing' | 'error';
  text: string;
  url?: string;
}

export interface PrInput {
  title: string;
  body: string;
  /** Draft unless the step says `draft: false`. */
  draft?: boolean;
  /** The branch to merge into. Default: the branch the repository has checked out. */
  base?: string;
  /** The git remote to push to. Default: origin. */
  remote?: string;
}

/** Run the GitHub CLI. ORSTRA_GH_BIN replaces `gh` (tests use a fake). Never asks for anything. */
function gh(cwd: string, args: string[]): { ok: boolean; out: string } {
  try {
    const out = execFileSync(process.env.ORSTRA_GH_BIN ?? 'gh', args, {
      cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8',
      env: { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' },
    });
    return { ok: true, out: out.trim() };
  } catch (err: any) {
    if (err?.code === 'ENOENT') return { ok: false, out: 'The GitHub CLI (gh) is not installed. Install it and run "gh auth login".' };
    return { ok: false, out: `${err?.stdout ?? ''}${err?.stderr ?? ''}`.trim() };
  }
}

const first = (s: string, n = 4) => s.split('\n').slice(0, n).join('\n');

/**
 * Push the task's branch and open a pull request for it with the GitHub CLI. It pushes only the task's
 * own branch, never with force. When a pull request is already open for the branch, it pushes the new
 * commits and returns that pull request.
 */
export function openPullRequest(worktree: string, input: PrInput): PrResult {
  if (!worktree || !existsSync(worktree) || !git(worktree, ['rev-parse', '--git-dir']).ok) {
    return { outcome: 'error', text: 'This task has no git worktree, so there is no branch to open a pull request for.' };
  }
  const main = mainCheckout(worktree);
  const top = git(worktree, ['rev-parse', '--show-toplevel']);
  if (!main.path || !top.ok || resolve(main.path) === resolve(top.out)) {
    return { outcome: 'error', text: 'This task has its own scratch repository with no remote, so it cannot open a pull request. Start the task with a repo.' };
  }
  const head = git(worktree, ['symbolic-ref', '--short', '-q', 'HEAD']);
  if (!head.ok) return { outcome: 'error', text: 'The task worktree is not on a branch, so there is nothing to push.' };
  const branch = head.out;
  const base = input.base ?? main.branch;
  if (!base) return { outcome: 'error', text: 'The main checkout is not on a branch. Set base: in the step.' };

  const ahead = git(worktree, ['rev-list', '--count', `${base}..HEAD`]);
  if (ahead.ok && Number(ahead.out) === 0) {
    return { outcome: 'nothing', text: `${branch} has no commits that ${base} does not have, so there is nothing to put in a pull request.` };
  }
  const remote = input.remote ?? 'origin';
  if (!git(worktree, ['remote', 'get-url', remote]).ok) return { outcome: 'error', text: `The repository has no remote called "${remote}".` };

  const dirty = git(worktree, ['status', '--porcelain', '--untracked-files=no']);
  const note = dirty.ok && dirty.out ? ` ${dirty.out.split('\n').length} uncommitted changes stay out of it.` : '';

  const push = git(worktree, ['push', '-u', remote, `${branch}:${branch}`]);
  if (!push.ok) return { outcome: 'error', text: `git could not push ${branch} to ${remote}. No pull request was opened.\n${first(push.out)}` };

  const existing = gh(worktree, ['pr', 'view', branch, '--json', 'url,state', '--jq', 'select(.state == "OPEN") | .url']);
  if (existing.ok && existing.out) {
    return { outcome: 'exists', url: existing.out, text: `Pushed ${branch}. The pull request ${existing.out} was already open, and now has the new commits.${note}` };
  }
  const args = ['pr', 'create', '--head', branch, '--base', base, '--title', input.title, '--body', input.body];
  if (input.draft !== false) args.push('--draft');
  const created = gh(worktree, args);
  if (!created.ok) return { outcome: 'error', text: `Pushed ${branch}, but gh did not open the pull request.\n${first(created.out)}` };
  const url = created.out.split('\n').find((l) => /^https?:\/\//.test(l.trim()))?.trim() ?? created.out;
  return { outcome: 'opened', url, text: `Opened ${input.draft === false ? 'the pull request' : 'a draft pull request'} ${url} from ${branch} into ${base}.${note}` };
}
