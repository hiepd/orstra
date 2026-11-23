import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

export const STEP_KINDS = ['agent', 'gate', 'human', 'switch', 'action', 'workflow'] as const;
export type StepKind = (typeof STEP_KINDS)[number];

/** The outcome that `next:` stands for, per step kind. */
export const SUCCESS_OUTCOME: Record<StepKind, string> = {
  agent: 'done',
  gate: 'pass',
  human: 'approved',
  action: 'ok',
  workflow: 'started',
  switch: 'default',
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
  /** No match means the step runs once more, then the task goes to your Inbox. */
  required: boolean;
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
  /** workflow */
  workflow?: string;
  timeoutMinutes?: number;
  /** Files this step produces, collected when the run ends. */
  artifacts?: ArtifactSpec[];
  /** outcome -> where to go */
  on: Record<string, Target>;
}

/**
 * What starts tasks on its own.
 * - linear: one task per open Linear issue with the label (and team and state, when set). With
 *   `comment` (default true), each progress entry goes back to the issue as a comment.
 * - schedule: one task every `everyMinutes`, with this title. The first task starts one interval
 *   after Orstra first sees the trigger.
 */
export type Trigger =
  | { kind: 'linear'; label: string; team?: string; state?: string; repo?: string; comment: boolean }
  | { kind: 'schedule'; everyMinutes: number; title: string; description?: string; repo?: string };

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

/** `artifacts: [".orstra/out/*.png"]` or the long form with a name and `required`. */
const artifactSchema = z.union([
  z.string(),
  z.object({ name: z.string().optional(), path: z.string(), required: z.boolean().optional() }),
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
    timeout: z.number().positive().optional(),
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
    schedule: z.object({ every: z.union([z.string(), z.number().positive()]), title: z.string(), description: z.string().optional(), repo: z.string().optional() }),
  }),
]);

function toTrigger(t: z.infer<typeof triggerSchema>): Trigger {
  if ('linear' in t) return { kind: 'linear', ...t.linear };
  const everyMinutes = parseEvery(t.schedule.every);
  if (!(everyMinutes >= 1)) throw new Error('A schedule trigger runs at most once a minute.');
  const { every: _every, ...rest } = t.schedule;
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

function toArtifact(a: z.infer<typeof artifactSchema>): ArtifactSpec {
  const path = typeof a === 'string' ? a : a.path;
  const name = typeof a === 'string' ? path : a.name ?? path;
  return { name, path, required: typeof a === 'string' ? false : a.required ?? false };
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
    if (s.next !== undefined) on[SUCCESS_OUTCOME[s.use]] = toTarget(s.next);
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
      timeoutMinutes: s.timeout,
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
    if (step.use === 'action') {
      if (!step.action) throw new Error(`Action step "${step.id}" needs an action: ${ACTION_NAMES.join(', ')}.`);
      if (!(ACTION_NAMES as readonly string[]).includes(step.action)) {
        throw new Error(`Action step "${step.id}" names "${step.action}", which Orstra does not have. Use one of: ${ACTION_NAMES.join(', ')}.`);
      }
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
