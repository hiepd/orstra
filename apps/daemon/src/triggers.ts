import { readFileSync } from 'node:fs';
import { parseWorkflow, type Progress, type Trigger } from '@orstra/core';
import type { Store, TaskRow } from './db.ts';
import type { Runner } from './runner.ts';
import { Schedules } from './schedules.ts';
import { listWorkflows } from './workflows.ts';

/** One Linear issue, as the trigger reads it. */
export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  url: string;
}

/** Calls Linear's GraphQL API. Tests pass a fake. */
export type LinearClient = (query: string, variables: Record<string, unknown>) => Promise<any>;

export function linearClient(apiKey: string, fetchImpl: typeof fetch = fetch): LinearClient {
  return async (query, variables) => {
    const res = await fetchImpl('https://api.linear.app/graphql', {
      method: 'POST',
      // A personal API key goes in the header as it is, with no "Bearer".
      headers: { 'content-type': 'application/json', authorization: apiKey },
      body: JSON.stringify({ query, variables }),
    });
    const body = (await res.json()) as any;
    if (!res.ok || body.errors?.length) throw new Error(body.errors?.[0]?.message ?? `Linear said ${res.status}`);
    return body.data;
  };
}

const ISSUES = `query OrstraIssues($filter: IssueFilter) {
  issues(filter: $filter, first: 50) { nodes { id identifier title description url } }
}`;

const COMMENT = `mutation OrstraComment($input: CommentCreateInput!) {
  commentCreate(input: $input) { success }
}`;

/** The Linear filter for a trigger: the label, and the team and state when set. Open issues only by default. */
export function issueFilter(t: Extract<Trigger, { kind: 'linear' }>): Record<string, unknown> {
  const f: Record<string, unknown> = { labels: { name: { eqIgnoreCase: t.label } } };
  if (t.team) f.team = { key: { eq: t.team } };
  f.state = t.state ? { name: { eqIgnoreCase: t.state } } : { type: { nin: ['completed', 'canceled'] } };
  return f;
}

/** A progress entry as a Linear comment: a summary, never the transcript. */
export function progressComment(stepTitle: string, attempt: number, outcome: string | null, p: Progress): string {
  const lines = [`**Orstra · ${stepTitle}${attempt > 1 ? ` (attempt ${attempt})` : ''}**${outcome ? ` · ${outcome}` : ''}`, '', `Did: ${p.did}`];
  if (p.decided && p.decided !== 'nothing') lines.push(`Decided: ${p.decided}`);
  if (p.left && p.left !== 'nothing') lines.push(`Left: ${p.left}`);
  return lines.join('\n');
}

export interface TriggerStatus {
  workflow: string;
  kind: Trigger['kind'];
  label: string;
  lastCheck: number | null;
  lastError: string | null;
  started: number;
}

/**
 * Starts tasks from triggers, and sends progress back to Linear. It reads the workflow files on each
 * check, so a trigger you add or change works on the next check without a restart.
 * Schedules, declarative and imperative, fire in the same check (see schedules.ts).
 */
export class Triggers {
  private status = new Map<string, TriggerStatus>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  readonly schedules: Schedules;

  constructor(
    private store: Store,
    private runner: Runner,
    private opts: { linear?: LinearClient | null; now?: () => number; workflows?: () => { path: string; file: string }[]; schedules?: Schedules } = {},
  ) {
    this.schedules = opts.schedules ?? new Schedules(store, runner, { now: opts.now, workflows: opts.workflows });
    runner.on('progress', (e: { taskId: string; runId: string; outcome?: string }) => void this.mirror(e.taskId, e.runId, e.outcome));
  }

  private now() {
    return (this.opts.now ?? Date.now)();
  }

  start(intervalMs = 60_000) {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  /** The Linear triggers and how their last check went. Schedules have their own view (schedules.list()). */
  view(): TriggerStatus[] {
    return [...this.status.values()];
  }

  /** Check every trigger once. A second call while one runs does nothing. */
  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      // 1 loop for every schedule: copy the declarative ones from the files, then fire what is due.
      try {
        this.schedules.sync();
        this.schedules.fireDue();
      } catch (err) {
        console.error('Schedules:', err);
      }
      for (const w of (this.opts.workflows ?? listWorkflows)()) {
        let triggers: Trigger[];
        try {
          triggers = parseWorkflow(readFileSync(w.path, 'utf8')).triggers;
        } catch {
          continue; // The Workflows screen shows the parse error.
        }
        for (const [i, t] of triggers.entries()) {
          if (t.kind !== 'linear') continue;
          const key = `${w.file}#${i}`;
          const st: TriggerStatus = this.status.get(key) ?? {
            workflow: w.file, kind: t.kind, label: `Linear label "${t.label}"${t.team ? ` in ${t.team}` : ''}`,
            lastCheck: null, lastError: null, started: 0,
          };
          this.status.set(key, st);
          try {
            st.started += await this.checkLinear(w.path, t);
            st.lastError = null;
          } catch (err: any) {
            st.lastError = err?.message ?? String(err);
          }
          st.lastCheck = this.now();
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async checkLinear(workflowPath: string, t: Extract<Trigger, { kind: 'linear' }>): Promise<number> {
    if (!this.opts.linear) throw new Error('Set LINEAR_API_KEY in the daemon environment to use Linear triggers.');
    const data = await this.opts.linear(ISSUES, { filter: issueFilter(t) });
    let n = 0;
    for (const issue of (data?.issues?.nodes ?? []) as LinearIssue[]) {
      const source = `linear:${issue.id}`;
      if (this.store.taskBySource(source, workflowPath)) continue;
      this.runner.startTask({
        workflowPath, title: issue.title, ref: issue.identifier, repo: t.repo, source,
        description: [issue.description?.trim(), `Linear: ${issue.url}`].filter(Boolean).join('\n\n'),
      });
      n++;
    }
    return n;
  }

  /** Send a run's progress entry to the Linear issue the task came from, when its trigger says so. */
  async mirror(taskId: string, runId: string, outcome?: string) {
    const task = this.store.task(taskId);
    const run = this.store.run(runId);
    if (!task?.source?.startsWith('linear:') || !run?.progress || !this.opts.linear) return;
    if (!this.commentsOn(task)) return;
    let title = run.step_id;
    try { title = this.runner.workflowFor(task).steps[run.step_id]?.title ?? run.step_id; } catch { /* keep the id */ }
    const body = progressComment(title, run.attempt, outcome ?? run.outcome, JSON.parse(run.progress) as Progress);
    try {
      await this.opts.linear(COMMENT, { input: { issueId: task.source.slice('linear:'.length), body } });
    } catch (err: any) {
      this.store.addEvent(taskId, runId, 'system', { text: `Could not post the progress to Linear: ${err?.message ?? err}` });
    }
  }

  private commentsOn(task: TaskRow): boolean {
    try {
      return this.runner.workflowFor(task).triggers.some((t) => t.kind === 'linear' && t.comment);
    } catch {
      return false;
    }
  }
}
