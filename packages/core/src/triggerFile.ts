import { parse as parseYaml, stringify } from 'yaml';
import { z } from 'zod';
import { checkCron, checkTimezone } from './cron.ts';
import { parseEvery, type Trigger } from './workflow.ts';

/**
 * A declarative trigger: 1 YAML file in the trigger folder (~/.orstra/triggers). It names the workflow
 * it starts, so a workflow never lists what starts it. The file name is the trigger's id. Only an edit
 * of the file changes it.
 *
 *   workflow: orstra-dogfood          # the workflow file, without .yaml, or its name
 *   schedule:
 *     cron: "0 9 * * 1-5"             # or every: 1d
 *     timezone: Europe/London
 *   title: "Dogfood {{ date }}"
 *   prompt: Try the Inbox and list what breaks.
 *   description: The morning dogfood.
 *   workspace: orstra
 *
 * Or, for Linear: `linear: { label, team, state, comment }` instead of `schedule:`, with no title.
 */
export interface TriggerFile {
  workflow: string;
  trigger: Trigger;
}

const fileSchema = z
  .object({
    workflow: z.string().min(1),
    schedule: z
      .object({ cron: z.string().optional(), timezone: z.string().optional(), every: z.union([z.string(), z.number().positive()]).optional() })
      .strict()
      .optional(),
    linear: z
      .object({ label: z.string(), team: z.string().optional(), state: z.string().optional(), comment: z.boolean().default(true) })
      .strict()
      .optional(),
    title: z.string().optional(),
    description: z.string().optional(),
    prompt: z.string().optional(),
    workspace: z.string().optional(),
    repo: z.string().optional(),
  })
  .strict();

/** Parse and check a trigger file. Throws with a readable message when it is wrong. */
export function parseTriggerFile(source: string): TriggerFile {
  const raw = fileSchema.parse(parseYaml(source));
  if (!raw.schedule === !raw.linear) throw new Error('A trigger file needs either schedule: or linear:, not both.');
  const opt = <T,>(k: string, v: T | undefined) => (v === undefined ? {} : { [k]: v });
  if (raw.linear) {
    for (const k of ['title', 'description', 'prompt'] as const) {
      if (raw[k] !== undefined) throw new Error(`A Linear trigger takes ${k}: from the issue, so the file cannot set it.`);
    }
    return {
      workflow: raw.workflow,
      trigger: { kind: 'linear', ...raw.linear, ...opt('repo', raw.repo), ...opt('workspace', raw.workspace) },
    };
  }
  const s = raw.schedule!;
  if (!raw.title?.trim()) throw new Error('A schedule needs title:, the title of the task it starts.');
  if ((s.every === undefined) === (s.cron === undefined)) throw new Error('schedule: needs either cron: (such as "0 9 * * 1-5") or every: (such as 1d), not both.');
  const task = { title: raw.title, ...opt('description', raw.description), ...opt('prompt', raw.prompt), ...opt('repo', raw.repo), ...opt('workspace', raw.workspace) };
  if (s.cron !== undefined) {
    return { workflow: raw.workflow, trigger: { kind: 'schedule', cron: checkCron(s.cron, s.timezone), ...opt('timezone', s.timezone ? checkTimezone(s.timezone) : undefined), ...task } };
  }
  if (s.timezone) throw new Error('timezone: works only with cron:. An every: interval has no time of day.');
  const everyMinutes = parseEvery(s.every!);
  if (!(everyMinutes >= 1)) throw new Error('A schedule runs at most once a minute.');
  return { workflow: raw.workflow, trigger: { kind: 'schedule', everyMinutes, ...task } };
}

/**
 * Write 1 entry of an old `triggers:` list in a workflow file as a trigger file. `raw` is the entry as
 * the YAML has it (`{ schedule: {...} }` or `{ linear: {...} }`), so `every: 1d` stays `every: 1d`.
 */
export function triggerFileFromEntry(workflow: string, raw: Record<string, any>): string {
  const out: Record<string, unknown> = { workflow };
  if (raw.linear) {
    const { repo, workspace, ...linear } = raw.linear;
    out.linear = linear;
    if (repo !== undefined) out.repo = repo;
    if (workspace !== undefined) out.workspace = workspace;
  } else if (raw.schedule) {
    const { cron, timezone, every, ...task } = raw.schedule;
    out.schedule = { ...(cron !== undefined ? { cron } : {}), ...(timezone !== undefined ? { timezone } : {}), ...(every !== undefined ? { every } : {}) };
    for (const k of ['title', 'prompt', 'description', 'workspace', 'repo']) if (task[k] !== undefined) out[k] = task[k];
  } else {
    throw new Error('The entry is neither schedule: nor linear:.');
  }
  return stringify(out);
}
