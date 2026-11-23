import { mergeTaskBranch } from './merge.ts';

export interface ActionContext {
  /** The task's worktree. */
  cwd: string;
  /** The step's `with:` map. */
  input: Record<string, unknown>;
}

export interface ActionResult {
  /** `ok` keeps the workflow moving. Any other outcome needs an arrow, or the task goes to the Inbox. */
  outcome: string;
  /** One or two sentences for the task's history. */
  text: string;
}

/**
 * What an `action` step can do, by name. Actions run on the machine, not in an agent session, so each
 * one is small and does its own safety checks. Names are read from the step's `action:` field.
 */
export const ACTIONS: Record<string, (ctx: ActionContext) => ActionResult> = {
  /** Merge the task's branch into the branch its repository has checked out. Local only; never pushes. */
  'git.merge': ({ cwd }) => {
    const res = mergeTaskBranch(cwd);
    return { outcome: res.outcome === 'merged' || res.outcome === 'nothing' ? 'ok' : res.outcome, text: res.text };
  },
};

/** Run a named action. An unknown name passes, so a workflow that names an action we don't have yet still moves. */
export function runAction(name: string | undefined, ctx: ActionContext): ActionResult {
  const action = name && ACTIONS[name];
  if (!action) return { outcome: 'ok', text: `Action "${name ?? 'none'}" isn't built yet; treated as ok.` };
  return action(ctx);
}
