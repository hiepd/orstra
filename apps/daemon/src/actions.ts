import type { ActionName } from '@orstra/core';
import { mergeTaskBranch } from './merge.ts';
import { openPullRequest } from './github.ts';
import { cleanupWorktree } from './cleanup.ts';

export interface ActionContext {
  /** The task's worktree. */
  cwd: string;
  /** The step's `with:` map. */
  input: Record<string, unknown>;
  /** The task, for actions that write about it (a pull request's title and body). */
  task?: { title: string; ref: string | null; description: string };
  /** The task's progress entries, one line per run. */
  progress?: string;
  /** Called just before git.cleanup removes the worktree (the runner stops the task's shells there). */
  beforeRemove?: () => void;
}

export interface ActionResult {
  /** `ok` keeps the workflow moving. Any other outcome needs an arrow, or the task goes to the Inbox. */
  outcome: string;
  /** One or two sentences for the task's history. */
  text: string;
  /** Set by `github.pr`: the pull request, so the task can link to it. */
  prUrl?: string;
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : undefined);

/** The body of a pull request Orstra opens: the ticket, what was asked, and what each run did. */
export function prBody(ctx: ActionContext): string {
  const t = ctx.task;
  return [
    t?.ref ? `Ticket: ${t.ref}` : '',
    t?.description ? `## What was asked\n\n${t.description}` : '',
    ctx.progress ? `## What the agents did\n\n${ctx.progress}` : '',
    '_Opened by Orstra._',
  ].filter(Boolean).join('\n\n');
}

/**
 * What an `action` step can do, by name. Actions run on the machine, not in an agent session, so each
 * one is small and does its own safety checks. Names are read from the step's `action:` field, and the
 * parser accepts only the names in ACTION_NAMES (packages/core), which a test keeps equal to these keys.
 */
export const ACTIONS: Record<ActionName, (ctx: ActionContext) => ActionResult> = {
  /** Merge the task's branch into the branch its repository has checked out. Local only; never pushes. */
  'git.merge': ({ cwd }) => {
    const res = mergeTaskBranch(cwd);
    return { outcome: res.outcome === 'merged' || res.outcome === 'nothing' ? 'ok' : res.outcome, text: res.text };
  },

  /**
   * Push the task's branch and open a pull request with the GitHub CLI (a draft unless `draft: false`).
   * `with:` takes title, body, draft, base and remote. Outcomes: ok, nothing (no commits), error.
   */
  'github.pr': (ctx) => {
    const title = str(ctx.input.title) ?? `${ctx.task?.ref ? ctx.task.ref + ' ' : ''}${ctx.task?.title ?? 'Orstra task'}`;
    const res = openPullRequest(ctx.cwd, {
      title,
      body: str(ctx.input.body) ?? prBody(ctx),
      draft: ctx.input.draft === false ? false : true,
      base: str(ctx.input.base),
      remote: str(ctx.input.remote),
    });
    const outcome = res.outcome === 'opened' || res.outcome === 'exists' ? 'ok' : res.outcome;
    return { outcome, text: res.text, prUrl: res.url };
  },

  /**
   * Remove the task's worktree, and its branch when it is merged. Put it last: steps after it have no
   * worktree. `with: { force: true }` also throws away uncommitted work. Outcomes: ok, refused.
   */
  'git.cleanup': ({ cwd, input, beforeRemove }) => {
    const res = cleanupWorktree(cwd, { force: input.force === true, beforeRemove });
    return { outcome: res.outcome === 'removed' ? 'ok' : 'refused', text: res.text };
  },
};

/**
 * May a restart run this action again, with no question? Only when a second run gives the same
 * result as the first. A new action must say so here, and a test keeps this list next to ACTIONS.
 * - git.merge: a branch that is merged has nothing left to merge, so it returns `nothing` (= ok). A
 *   merge the crash left half done keeps MERGE_HEAD, and the second run stops with `error`.
 * - github.pr: the push changes nothing, and `gh pr view` finds the open pull request (`exists` = ok).
 * - git.cleanup: a worktree that is gone returns `removed` (= ok).
 */
export const RERUN_SAFE: Record<ActionName, boolean> = {
  'git.merge': true,
  'github.pr': true,
  'git.cleanup': true,
};

/** Run a named action. The parser refuses an unknown name; if one gets here anyway, it is an error, never a pass. */
export function runAction(name: string | undefined, ctx: ActionContext): ActionResult {
  const action = name && (ACTIONS as Record<string, (ctx: ActionContext) => ActionResult>)[name];
  if (!action) return { outcome: 'error', text: `Orstra has no action "${name ?? 'none'}", so nothing ran.` };
  return action(ctx);
}
