import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { checkCron, checkTimezone } from './cron.ts';
import { AGENT_RETRY, NO_RETRY, parseDuration, type RetryPolicy } from './duration.ts';

export const STEP_KINDS = ['agent', 'gate', 'human', 'switch', 'action', 'workflow', 'wait'] as const;
export type StepKind = (typeof STEP_KINDS)[number];

/** The outcome that `next:` stands for, per step kind. */
export const SUCCESS_OUTCOME: Record<StepKind, string> = {
  agent: 'done',
  gate: 'pass',
  human: 'approved',
  action: 'ok',
  workflow: 'started',
  switch: 'default',
  wait: 'done',
};

export const END = 'end';

/**
 * The actions an `action` step can name. The daemon runs them (apps/daemon/src/actions.ts) and a test
 * keeps the two lists equal. A name outside this list is a parse error, so a typo never passes silently.
 */
export const ACTION_NAMES = ['git.merge', 'github.pr', 'git.cleanup'] as const;
export type ActionName = (typeof ACTION_NAMES)[number];

export interface Target {
  goto: string;
  /** How many times this arrow may be followed for one task. Unset = unlimited. */
  max?: number;
}

/**
 * A file a step produces, kept for the review and for later steps. The step writes it in the
 * worktree; Orstra copies every match out when the run ends.
 */
export interface ArtifactSpec {
  /** What this group is, for the review ("screen", "coverage"). Defaults to the glob. */
  name: string;
  /** Glob, relative to the worktree: `.orstra/out/*.png`, `coverage/**\/*.html`. */
  path: string;
}

export interface Step {
  id: string;
  use: StepKind;
  title?: string;
  /** agent */
  agent?: 'claude-code' | 'codex';
  model?: string;
  prompt?: string;
  /** gate */
  run?: string[];
  /** human */
  question?: string;
  choices?: string[];
  /** switch */
  value?: string;
  /** action */
  action?: string;
  with?: Record<string, unknown>;
  /** workflow: the workflow each child task follows, by name or path. */
  workflow?: string;
  /** workflow: start 1 child for each item of this list, such as `steps.split.data.items`. */
  forEach?: string;
  /** workflow: wait until every child task ends (outcome done, partial or failed). Else go on at once (started). */
  waitChildren?: boolean;
  /** wait: a timer of this many ms, a time to wait until (ISO, templating works), or a callback URL. */
  waitMs?: number;
  until?: string;
  /** wait: an outside system completes the run by a POST to its URL. `timeoutMs` ends it with `timeout`. */
  callback?: { timeoutMs?: number };
  timeoutMinutes?: number;
  /**
   * gate, action: may a restart run this step again from the start? Unset = yes for a gate, and for
   * an action that is safe to run twice. `false` sends the task to your Inbox instead: use it for a
   * command that changes something outside the worktree, such as a deploy.
   */
  rerun?: boolean;
  /** agent, gate: what to do after a fault. Unset = AGENT_RETRY for an agent, no retry for a gate. */
  retry?: RetryPolicy;
  /** Run the step only when the value matches 1 of `is` (as a switch matches). Else it ends with `skipped`. */
  when?: { value: string; is: string[] };
  /** Files this step produces, collected when the run ends. */
  artifacts?: ArtifactSpec[];
  /** outcome -> where to go */
  on: Record<string, Target>;
}

/**
 * What starts tasks on its own.
 * - linear: one task per open Linear issue with the label (and team and state, when set). With
 *   `comment` (default true), each progress entry goes back to the issue as a comment.
 * Triggers now live in their own files (see triggerFile.ts). A workflow file can still have a `triggers:`
 * list: the daemon moves each entry into a trigger file and removes the list. It is still parsed, so a
 * task that started before that, and keeps its workflow as it was, still reads.
 * - schedule: a declarative schedule. It starts one task each time `cron` matches in `timezone`
 *   (UTC when unset), or every `everyMinutes`. An interval counts from when Orstra first saw the trigger.
 *   It has exactly 1 of the 2. Only an edit of the workflow file changes it; the app makes imperative
 *   schedules, which the daemon keeps in its database.
 */
export type Trigger =
  | { kind: 'linear'; label: string; team?: string; state?: string; repo?: string; workspace?: string; comment: boolean }
  | {
      kind: 'schedule';
      cron?: string;
      timezone?: string;
      everyMinutes?: number;
      title: string;
      description?: string;
      /** What the agents of each task get, after each step's own prompt. */
      prompt?: string;
      repo?: string;
      /** The workspace the task works in, by name. */
      workspace?: string;
    };

/** "30m", "6h", "1d" or a number of minutes -> minutes. */
export function parseEvery(v: string | number): number {
  if (typeof v === 'number') return v;
  const m = v.trim().match(/^(\d+(?:\.\d+)?)\s*(m|min|h|d)?$/i);
  if (!m) throw new Error(`"${v}" is not an interval. Write it like 30m, 6h or 1d.`);
  const n = Number(m[1]);
  const unit = (m[2] ?? 'm').toLowerCase();
  return unit === 'd' ? n * 1440 : unit === 'h' ? n * 60 : n;
}

export interface Workflow {
  name: string;
  description?: string;
  repo?: string;
  concurrency: number;
  /** Stop starting agent work on a task once its runs cost this much (US dollars). Unset = no cap. */
  budgetUsd?: number;
  start: string;
  triggers: Trigger[];
  steps: Record<string, Step>;
  /** Where each step sits on the canvas: id -> [x, y]. Only the editor reads this. */
  layout: Record<string, [number, number]>;
}

const targetSchema = z.union([
  z.string(),
  z.object({ goto: z.string(), max: z.number().int().positive().optional() }),
]);

/** `artifacts: ["coverage/index.html"]` or the long form with a name. Never blocks a run. */
const artifactSchema = z.union([
  z.string(),
  z.object({ name: z.string().optional(), path: z.string() }),
]);

const stepSchema = z
  .object({
    use: z.enum(STEP_KINDS),
    title: z.string().optional(),
    agent: z.enum(['claude-code', 'codex']).optional(),
    model: z.string().optional(),
    prompt: z.string().optional(),
    run: z.union([z.string(), z.array(z.string())]).optional(),
    question: z.string().optional(),
    choices: z.array(z.string()).optional(),
    value: z.string().optional(),
    cases: z.record(targetSchema).optional(),
    action: z.string().optional(),
    with: z.record(z.unknown()).optional(),
    workflow: z.string().optional(),
    for_each: z.string().optional(),
    wait: z.boolean().optional(),
    for: z.union([z.string(), z.number()]).optional(),
    until: z.string().optional(),
    callback: z.union([z.literal(true), z.object({ timeout: z.union([z.string(), z.number()]).optional() })]).optional(),
    timeout: z.number().positive().optional(),
    rerun: z.boolean().optional(),
    when: z.object({ value: z.string(), is: z.union([z.string(), z.array(z.string()).min(1)]) }).optional(),
    retry: z.union([
      z.literal(false),
      z.object({
        max: z.number().int().min(0).optional(),
        delay: z.union([z.string(), z.number()]).optional(),
        factor: z.number().min(1).optional(),
        maxDelay: z.union([z.string(), z.number()]).optional(),
        onTimeout: z.boolean().optional(),
      }),
    ]).optional(),
    artifacts: z.array(artifactSchema).optional(),
    next: targetSchema.optional(),
    on: z.record(targetSchema).optional(),
  })
  .passthrough();

const triggerSchema = z.union([
  z.object({
    linear: z.object({ label: z.string(), team: z.string().optional(), state: z.string().optional(), repo: z.string().optional(), comment: z.boolean().default(true) }),
  }),
  z.object({
    schedule: z.object({
      cron: z.string().optional(),
      timezone: z.string().optional(),
      every: z.union([z.string(), z.number().positive()]).optional(),
      title: z.string(),
      description: z.string().optional(),
      prompt: z.string().optional(),
      repo: z.string().optional(),
      workspace: z.string().optional(),
    }),
  }),
]);

function toTrigger(t: z.infer<typeof triggerSchema>): Trigger {
  if ('linear' in t) return { kind: 'linear', ...t.linear };
  const { every, cron, timezone, ...rest } = t.schedule;
  if ((every === undefined) === (cron === undefined)) throw new Error('A schedule trigger needs either cron: (such as "0 9 * * 1-5") or every: (such as 1d), not both.');
  if (cron !== undefined) {
    return { kind: 'schedule', cron: checkCron(cron, timezone), ...(timezone ? { timezone: checkTimezone(timezone) } : {}), ...rest };
  }
  if (timezone) throw new Error('timezone: works only with cron:. An every: interval has no time of day.');
  const everyMinutes = parseEvery(every!);
  if (!(everyMinutes >= 1)) throw new Error('A schedule trigger runs at most once a minute.');
  return { kind: 'schedule', everyMinutes, ...rest };
}

const workflowSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  repo: z.string().optional(),
  concurrency: z.number().int().positive().default(3),
  budget_usd: z.number().positive().optional(),
  start: z.string().optional(),
  triggers: z.array(triggerSchema).default([]),
  steps: z.record(stepSchema),
  layout: z.record(z.tuple([z.number(), z.number()])).default({}),
});

function toTarget(t: z.infer<typeof targetSchema>): Target {
  return typeof t === 'string' ? { goto: t } : { goto: t.goto, ...(t.max ? { max: t.max } : {}) };
}

/** A wait step: exactly 1 of `for`, `until` and `callback`. */
function toWait(stepId: string, s: { for?: string | number; until?: string; callback?: true | { timeout?: string | number } }): Pick<Step, 'waitMs' | 'until' | 'callback'> {
  const given = [s.for !== undefined, s.until !== undefined, s.callback !== undefined].filter(Boolean).length;
  if (given !== 1) throw new Error(`Wait step "${stepId}" needs exactly 1 of for, until and callback.`);
  const ms = (v: string | number) => {
    try { return parseDuration(v); } catch (err: any) { throw new Error(`Wait step "${stepId}": ${err.message}`); }
  };
  if (s.for !== undefined) return { waitMs: ms(s.for) };
  if (s.until !== undefined) return { until: s.until };
  const timeout = s.callback === true ? undefined : s.callback?.timeout;
  return { callback: timeout === undefined ? {} : { timeoutMs: ms(timeout) } };
}

/** `retry: false`, or the fields that differ from the default of the step kind. */
function toRetry(stepId: string, use: StepKind, r: false | { max?: number; delay?: string | number; factor?: number; maxDelay?: string | number; onTimeout?: boolean }): RetryPolicy {
  if (use !== 'agent' && use !== 'gate') throw new Error(`Step "${stepId}" sets retry, which works on agent and gate steps only.`);
  const base = use === 'agent' ? AGENT_RETRY : { ...NO_RETRY, max: 2 };
  if (r === false) return { ...base, max: 0 };
  const ms = (v: string | number | undefined, d: number) => {
    if (v === undefined) return d;
    try { return parseDuration(v); } catch (err: any) { throw new Error(`Step "${stepId}", retry: ${err.message}`); }
  };
  return {
    max: r.max ?? base.max,
    delayMs: ms(r.delay, base.delayMs),
    factor: r.factor ?? base.factor,
    maxDelayMs: ms(r.maxDelay, base.maxDelayMs),
    onTimeout: r.onTimeout ?? base.onTimeout,
  };
}

/** The retry policy a step follows: its own, or the default of its kind. */
export function retryPolicy(step: Step): RetryPolicy {
  return step.retry ?? (step.use === 'agent' ? AGENT_RETRY : NO_RETRY);
}

function toArtifact(a: z.infer<typeof artifactSchema>): ArtifactSpec {
  const path = typeof a === 'string' ? a : a.path;
  const name = typeof a === 'string' ? path : a.name ?? path;
  return { name, path };
}

/** An artifact path stays inside the worktree: no leading slash, no "..", no "~". */
function checkArtifactPath(stepId: string, path: string) {
  const bad =
    !path.trim() ? 'is empty' :
    path.startsWith('/') ? 'must be relative to the worktree' :
    path.startsWith('~') ? 'must be relative to the worktree' :
    path.split('/').includes('..') ? 'must not leave the worktree with ".."' :
    null;
  if (bad) throw new Error(`Step "${stepId}", artifact "${path}" ${bad}.`);
}

/** Parse and validate workflow YAML. Throws with a readable message when it's wrong. */
export function parseWorkflow(source: string): Workflow {
  const raw = workflowSchema.parse(parseYaml(source));
  const ids = Object.keys(raw.steps);
  if (ids.length === 0) throw new Error('A workflow needs at least one step.');

  const steps: Record<string, Step> = {};
  for (const id of ids) {
    const s = raw.steps[id];
    const on: Record<string, Target> = {};
    if (s.use === 'switch') {
      for (const [k, v] of Object.entries(s.cases ?? {})) on[k] = toTarget(v);
    }
    // A workflow step that waits ends with done, so its `next:` stands for done, not started.
    const success = s.use === 'workflow' && s.wait ? 'done' : SUCCESS_OUTCOME[s.use];
    if (s.next !== undefined) on[success] = toTarget(s.next);
    for (const [k, v] of Object.entries(s.on ?? {})) on[k] = toTarget(v);

    steps[id] = {
      id,
      use: s.use,
      title: s.title,
      agent: s.use === 'agent' ? s.agent ?? 'claude-code' : undefined,
      model: s.model,
      prompt: s.prompt,
      run: typeof s.run === 'string' ? [s.run] : s.run,
      question: s.question,
      choices: s.choices,
      value: s.value,
      action: s.action,
      with: s.with,
      workflow: s.workflow,
      ...(s.use === 'workflow' ? { ...(s.for_each ? { forEach: s.for_each } : {}), waitChildren: !!s.wait } : {}),
      ...(s.use === 'wait' ? toWait(id, s) : {}),
      timeoutMinutes: s.timeout,
      ...(s.rerun !== undefined ? { rerun: s.rerun } : {}),
      ...(s.when ? { when: { value: s.when.value, is: typeof s.when.is === 'string' ? [s.when.is] : s.when.is } } : {}),
      ...(s.retry !== undefined ? { retry: toRetry(id, s.use, s.retry) } : {}),
      artifacts: s.artifacts?.map(toArtifact),
      on,
    };
  }

  const start = raw.start ?? ids[0];
  if (!steps[start]) throw new Error(`start: "${start}" is not a step.`);
  for (const step of Object.values(steps)) {
    for (const [outcome, t] of Object.entries(step.on)) {
      if (t.goto !== END && !steps[t.goto]) {
        throw new Error(`Step "${step.id}", outcome "${outcome}" points to "${t.goto}", which is not a step.`);
      }
    }
    if (step.use === 'agent' && !step.prompt) throw new Error(`Agent step "${step.id}" needs a prompt.`);
    if (step.use === 'gate' && !step.run?.length) throw new Error(`Gate step "${step.id}" needs run commands.`);
    if (step.use === 'workflow' && !step.workflow?.trim()) throw new Error(`Workflow step "${step.id}" needs a workflow: the name or path of the workflow its tasks follow.`);
    if (step.use === 'action') {
      if (!step.action) throw new Error(`Action step "${step.id}" needs an action: ${ACTION_NAMES.join(', ')}.`);
      if (!(ACTION_NAMES as readonly string[]).includes(step.action)) {
        throw new Error(`Action step "${step.id}" names "${step.action}", which Orstra does not have. Use one of: ${ACTION_NAMES.join(', ')}.`);
      }
    }
    if (step.rerun !== undefined && step.use !== 'gate' && step.use !== 'action') {
      throw new Error(`Step "${step.id}" sets rerun, which works on gate and action steps only.`);
    }
    for (const a of step.artifacts ?? []) checkArtifactPath(step.id, a.path);
  }

  return {
    name: raw.name,
    description: raw.description,
    repo: raw.repo,
    concurrency: raw.concurrency,
    ...(raw.budget_usd !== undefined ? { budgetUsd: raw.budget_usd } : {}),
    start,
    triggers: raw.triggers.map(toTrigger),
    steps,
    layout: raw.layout,
  };
}
