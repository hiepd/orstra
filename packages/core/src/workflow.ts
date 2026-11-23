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

export interface Target {
  goto: string;
  /** How many times this arrow may be followed for one task. Unset = unlimited. */
  max?: number;
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
  /** outcome -> where to go */
  on: Record<string, Target>;
}

export interface Workflow {
  name: string;
  description?: string;
  repo?: string;
  concurrency: number;
  start: string;
  triggers: unknown[];
  steps: Record<string, Step>;
}

const targetSchema = z.union([
  z.string(),
  z.object({ goto: z.string(), max: z.number().int().positive().optional() }),
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
    next: targetSchema.optional(),
    on: z.record(targetSchema).optional(),
  })
  .passthrough();

const workflowSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  repo: z.string().optional(),
  concurrency: z.number().int().positive().default(3),
  start: z.string().optional(),
  triggers: z.array(z.unknown()).default([]),
  steps: z.record(stepSchema),
});

function toTarget(t: z.infer<typeof targetSchema>): Target {
  return typeof t === 'string' ? { goto: t } : { goto: t.goto, ...(t.max ? { max: t.max } : {}) };
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
  }

  return {
    name: raw.name,
    description: raw.description,
    repo: raw.repo,
    concurrency: raw.concurrency,
    start,
    triggers: raw.triggers,
    steps,
  };
}
