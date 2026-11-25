import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, extname, join, resolve, sep } from 'node:path';
import { applyEdits, deriveState, parseWorkflow, taskPath, type EditGraph, type Progress, type Workflow } from '@orstra/core';
import { MAX_FILE_BYTES, checkAttachments, cosFiles, mb, readAttachment, saveAttachment, taskFiles, type AttachStore } from './attachments.ts';
import type { ArtifactRow, EventRow, RunRow, Store, TaskRow } from './db.ts';
import { kindOf } from './artifacts.ts';
import type { Runner } from './runner.ts';
import type { ChiefOfStaff } from './cos.ts';
import type { Triggers } from './triggers.ts';
import { gitDiff, gitInfo } from './git.ts';
import { taskFacts } from './project.ts';
import { createWorkspace, defaultBranch, deleteWorkspace, pickWorkspace, updateWorkspace, workspaceView } from './workspace.ts';
import { locateWorkflow } from './workflows.ts';
import { expandHome } from './paths.ts';
import { agentRoots, listFiles, readTaskFile } from './files.ts';
import { linkInfo } from './linkInfo.ts';
import { Terminals } from './terminals.ts';
import { DevServers } from './devServers.ts';

/** The shells and dev servers the side viewer runs. Tests pass their own. */
export interface ServerExtras {
  terminals?: Terminals;
  devServers?: DevServers;
  /** How often the event stream beats. A test shortens it; see HEARTBEAT_MS. */
  heartbeatMs?: number;
}

/** The largest body of keys the terminal takes in one POST. */
const MAX_INPUT_BODY = 64 * 1024;
import { listWorkflows, resolveWorkflow } from './workflows.ts';
export { listWorkflows, resolveWorkflow };
import { AGENT_IDS, EFFORTS, PERMISSION_MODES, loadAgentConfig, saveAgentSettings, type AgentId } from './agentConfig.ts';
import { ARTIFACTS, COS_DIR, DB_PATH, HOME, PORT, SLOTS, WEB_DIST, WORKFLOW_DIRS, WORKTREES } from './paths.ts';
import { guardOptionsFromEnv, refuseReason } from './guard.ts';

const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png' };
/** An upload body: base64 of a file at the cap, plus the JSON around it. */
const MAX_UPLOAD_BODY = Math.ceil(MAX_FILE_BYTES * 4 / 3) + 4096;

function send(res: ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** Send one attachment's bytes, or 404. The same answer for a task chat and for the chief of staff. */
function sendAttachment(res: ServerResponse, store: AttachStore | null, path: string): boolean {
  const hit = store ? readAttachment(store, path) : null;
  if (!hit) return send(res, 404, { error: 'No such file' }), true;
  return sendBytes(res, hit);
}

/** Bytes from outside Orstra (an attachment, a worktree file), sent so that they can never run. */
function sendBytes(res: ServerResponse, hit: { body: Buffer; mime: string; name: string }, cache = 'private, max-age=86400'): boolean {
  res.writeHead(200, {
    'content-type': hit.mime, 'content-length': hit.body.length,
    'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(hit.name)}`,
    'cache-control': cache,
    // The bytes came from outside Orstra: never sniff them, never let an SVG run anything.
    'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox",
  });
  res.end(hit.body);
  return true;
}

async function readJson(req: IncomingMessage): Promise<any> {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

function workflowView(wf: Workflow) {
  return {
    name: wf.name, description: wf.description ?? null, repo: wf.repo ?? null, start: wf.start, concurrency: wf.concurrency, layout: wf.layout,
    steps: Object.values(wf.steps).map((s) => ({
      id: s.id, title: s.title ?? s.id, kind: s.use, agent: s.agent ?? null, model: s.model ?? null, prompt: s.prompt ?? null, run: s.run ?? null,
      question: s.question ?? null, choices: s.choices ?? null, value: s.value ?? null, action: s.action ?? null, workflow: s.workflow ?? null,
      on: Object.entries(s.on).map(([outcome, t]) => ({ outcome, to: t.goto, toTitle: t.goto === 'end' ? 'End' : wf.steps[t.goto]?.title ?? t.goto, max: t.max ?? null })),
    })),
  };
}

/** One workflow file: its YAML and, when it parses, its steps and arrows. */
export function workflowDetail(file: string) {
  const hit = listWorkflows().find((w) => w.file === file);
  if (!hit) return null;
  const yaml = readFileSync(hit.path, 'utf8');
  try {
    return { file: hit.file, path: hit.path, yaml, error: null, ...workflowView(parseWorkflow(yaml)) };
  } catch (err: any) {
    return { file: hit.file, path: hit.path, yaml, error: err?.message ?? String(err), name: hit.name, description: null, repo: null, start: null, concurrency: null, layout: {}, steps: [] };
  }
}

let agentCache: { id: string; name: string; command: string; path: string | null }[] | null = null;
/** Which agent CLIs are installed on this machine (looked up once). */
function agents() {
  if (agentCache) return agentCache;
  const find = (cmd: string) => {
    try { return execFileSync('which', [cmd], { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).trim() || null; } catch { return null; }
  };
  agentCache = [
    { id: 'claude-code', name: 'Claude Code', command: 'claude', path: find('claude') },
    { id: 'codex', name: 'Codex', command: 'codex', path: find('codex') },
  ];
  return agentCache;
}

function parseEvent(e: EventRow) {
  return { id: e.id, runId: e.run_id, ts: e.ts, kind: e.kind, ...JSON.parse(e.payload) };
}

/** How tasks, runs and worktrees look to the UI and to the chief of staff. */
export function makeViews(store: Store, runner: Runner) {
  const stepTitle = (task: TaskRow, stepId: string) => {
    try { return runner.workflowFor(task).steps[stepId]?.title ?? stepId; } catch { return stepId; }
  };

  /** One file a run produced, as the UI shows it. `url` is null when there are no bytes to serve. */
  const artifactView = (a: ArtifactRow) => ({
    id: a.id, runId: a.run_id, stepId: a.step_id, name: a.name, label: a.label, state: a.state,
    mime: a.mime, kind: kindOf(a.mime), bytes: a.bytes, createdAt: a.created_at,
    url: a.state === 'saved' ? `/api/artifacts/${a.id}` : null,
  });

  const runView = (task: TaskRow, r: RunRow) => ({
    id: r.id, taskId: r.task_id, stepId: r.step_id, stepTitle: stepTitle(task, r.step_id), kind: r.kind, attempt: r.attempt,
    artifacts: store.artifactsForRun(r.id).map(artifactView),
    status: r.status, outcome: r.outcome, agent: r.agent, sessionId: r.session_id,
    progress: r.progress ? (JSON.parse(r.progress) as Progress) : null, output: r.output,
    createdAt: r.created_at, startedAt: r.started_at, endedAt: r.ended_at,
    costUsd: r.cost_usd, tokensIn: r.tokens_in, tokensOut: r.tokens_out,
    openCommand: r.session_id && task.worktree ? (r.agent === 'codex' ? `cd ${task.worktree} && codex resume ${r.session_id}` : `cd ${task.worktree} && claude --resume ${r.session_id}`) : null,
    forkCommand: r.session_id && task.worktree ? (r.agent === 'codex' ? `cd ${task.worktree} && codex fork ${r.session_id}` : `cd ${task.worktree} && claude --resume ${r.session_id} --fork-session`) : null,
    live: runner.isLive(r.id),
  });

  const taskSummary = (t: TaskRow) => {
    const runs = store.runsForTask(t.id);
    // The run that says where the task is: the latest one at its current step, else its latest run.
    const cur = (t.current_step ? [...runs].reverse().find((r) => r.step_id === t.current_step) : undefined) ?? runs[runs.length - 1];
    const lastAgent = [...runs].reverse().find((r) => r.kind === 'agent');
    // Worked out at the read, with the sessions this process holds, so a screen is right the moment
    // one dies. The stored columns carry the same answer, minus what only memory knows.
    const d = deriveState(taskFacts(store, (id) => runner.isLive(id), t, runs));
    return {
      id: t.id, ref: t.ref, title: t.title, workflow: t.workflow_name, workflowFile: basename(t.workflow_path), status: t.status, currentStep: t.current_step,
      state: d.state, stateReason: d.reason, lastTurnAt: d.lastTurnAt,
      currentStepTitle: t.current_step ? stepTitle(t, t.current_step) : null, inboxReason: t.inbox_reason,
      run: cur ? { status: cur.status, attempt: cur.attempt, kind: cur.kind } : null, agent: lastAgent?.agent ?? null,
      createdAt: t.created_at, updatedAt: t.updated_at,
      cost: store.taskCost(t.id), prUrl: t.pr_url, source: t.source, archivedAt: t.archived_at,
      workspace: (() => { const w = t.workspace_id ? store.workspace(t.workspace_id) : undefined; return w ? { id: w.id, name: w.name } : null; })(),
    };
  };

  /** The permission question open for a task: which tool, and what it wants to do. */
  const permissionView = (taskId: string) => {
    const p = runner.pendingPermission(taskId);
    if (!p) return null;
    const input = JSON.stringify(p.input, null, 2);
    return { id: p.id, runId: p.runId, tool: p.tool, summary: p.summary, input: input.length > 4000 ? input.slice(0, 4000) + '\n…' : input, ts: p.ts };
  };

  /**
   * One task in full. `after` sends only the events after that event id (the UI keeps the rest), and
   * `events: false` sends none (the Inbox shows no transcript).
   */
  const taskDetail = (t: TaskRow, opts: { after?: number; events?: boolean } = {}) => {
    const runs = store.runsForTask(t.id).map((r) => runView(t, r));
    let steps: { id: string; title: string; kind: string; agent: string | null; on: Record<string, string> }[] = [];
    let human: unknown = null;
    let track: { id: string; title: string; kind: string; state: 'done' | 'current' | 'todo' }[] = [];
    try {
      const wf = runner.workflowFor(t);
      steps = Object.values(wf.steps).map((s) => ({
        id: s.id, title: s.title ?? s.id, kind: s.use, agent: s.agent ?? null,
        on: Object.fromEntries(Object.entries(s.on).map(([k, v]) => [k, v.goto === 'end' ? 'end' : wf.steps[v.goto]?.title ?? v.goto])),
      }));
const path = taskPath(wf, runs.map((r) => r.stepId), t.current_step);
      const at = t.current_step ? path.indexOf(t.current_step) : -1;
      const finished = t.status === 'done';
      track = path.map((id, i) => ({
        id, title: wf.steps[id].title ?? id, kind: wf.steps[id].use,
        state: finished || (at >= 0 && i < at) ? 'done' as const : i === at ? 'current' as const : at < 0 && runs.some((r) => r.stepId === id) ? 'done' as const : 'todo' as const,
      }));
            const waiting = runs.find((r) => r.status === 'waiting' && r.kind === 'human');
      if (waiting) {
        const step = wf.steps[waiting.stepId];
        const lastAgent = [...runs].reverse().find((r) => r.kind === 'agent' && r.progress);
        // Everything produced since your last decision, whichever step made it: a gate writes
        // artifacts as often as an agent does.
        const decided = [...runs].reverse().find((r) => r.kind === 'human' && r.outcome);
        const round = decided ? runs.slice(runs.indexOf(decided) + 1) : runs;
        // `subject` is what you decide about: what the agent said. `artifacts` is what it left behind.
        human = {
          runId: waiting.id, question: step.question ?? 'Decide', choices: Object.keys(step.on),
          subject: lastAgent ? { step: lastAgent.stepTitle, attempt: lastAgent.attempt, progress: lastAgent.progress } : null,
          artifacts: round.flatMap((r) => r.artifacts.map((a) => ({ ...a, stepTitle: r.stepTitle, attempt: r.attempt }))),
        };
      }
    } catch (err) {
      steps = [];
    }
    const events = opts.events === false ? [] : (opts.after !== undefined ? store.eventsAfter(t.id, opts.after) : store.events(t.id)).map(parseEvent);
    // An agent run that is waiting on you: it asked a question, answered you, or you stopped it.
    const agentWaiting = runs.find((r) => r.status === 'waiting' && r.kind === 'agent');
    const lastRow = agentWaiting ? store.lastRunEvent(agentWaiting.id, 'message') : undefined;
    const lastMsg = lastRow ? parseEvent(lastRow) : null;
    const awaiting = agentWaiting ? { runId: agentWaiting.id, reason: t.inbox_reason, text: lastMsg?.text ?? null } : null;
    const working = runs.find((r) => r.kind === 'agent' && r.status === 'running' && r.live) ?? null;
    // Notes waiting for a step: written since that step last started, so its next run will read them.
    const notes: Record<string, { text: string; ts: number }[]> = {};
    for (const e of store.eventsOfKind(t.id, 'note').map(parseEvent)) {
      if (!e.step) continue;
      const lastRun = [...runs].reverse().find((r) => r.stepId === e.step);
      if (lastRun && e.ts < lastRun.createdAt) continue;
      (notes[e.step] ??= []).push({ text: e.text, ts: e.ts });
    }
    return {
      ...taskSummary(t), description: t.description, worktree: t.worktree,
      baseBranch: t.base_branch ?? null, baseCommit: t.base_commit ?? null, subdir: t.subdir ?? null, setupAt: t.setup_at ?? null, steps, track, notes, runs, human, awaiting, workingRunId: working?.id ?? null,
      worktreeGone: !!t.worktree && !existsSync(t.worktree),
      budgetUsd: (() => { try { return runner.workflowFor(t).budgetUsd ?? null; } catch { return null; } })(),
      events, eventsAfter: opts.after ?? null, workflowChanged: runner.workflowChanged(t), permission: permissionView(t.id),
      lastSystem: (() => { const e = store.lastTaskEvent(t.id, 'system'); return e ? (JSON.parse(e.payload).text as string) : null; })(),
    };
  };

  /** The task's worktree as a coding tool would show it: branch, changes, commits, and the checks that ran. */
  const gitView = (t: TaskRow) => {
    const info = t.worktree ? gitInfo(t.worktree, { branch: t.base_branch ?? null, commit: t.base_commit ?? null }) : null;
    const checks = store.runsForTask(t.id).filter((r) => r.kind === 'gate').reverse().map((r) => ({
      runId: r.id, name: stepTitle(t, r.step_id) + (r.attempt > 1 ? ` · attempt ${r.attempt}` : ''),
      state: r.status === 'running' || r.status === 'queued' ? 'running' : r.outcome === 'pass' ? 'pass' : r.status === 'stopped' ? 'stopped' : 'fail',
      detail: (r.output ?? '').trim().split('\n').slice(-8).join('\n'), endedAt: r.ended_at,
    }));
    // Newest run first, so the panel reads like the Runs list: what just happened is on top.
    const attempts = new Map(store.runsForTask(t.id).map((r) => [r.id, r.attempt]));
    const artifacts = store.artifactsForTask(t.id).reverse().map((a) => ({
      ...artifactView(a), stepTitle: stepTitle(t, a.step_id), attempt: attempts.get(a.run_id) ?? 1,
    }));
    return { worktree: t.worktree, branch: info?.branch ?? null, base: info?.base ?? null, ahead: info?.ahead ?? 0, uncommitted: info?.uncommitted ?? 0,
      files: info?.files ?? [], commits: info?.commits ?? [], checks, artifacts, pr: t.pr_url ? { url: t.pr_url } : null };
  };

  return { stepTitle, runView, taskSummary, taskDetail, gitView };
}

export type Views = ReturnType<typeof makeViews>;

export function buildApi(store: Store, runner: Runner, cos?: ChiefOfStaff, triggers?: Triggers, extras: ServerExtras = {}) {
  const terminals = extras.terminals ?? new Terminals();
  const devServers = extras.devServers ?? new DevServers();
  const { runView, taskSummary, taskDetail, gitView } = makeViews(store, runner);
  const sessions = () => {
    const since = Date.now() - 24 * 3600_000;
    const rows = [...store.runsByStatus('running', 'waiting', 'queued'), ...store.runsSince(since).filter((r) => !['running', 'queued', 'waiting'].includes(r.status))]
      .filter((r) => r.kind === 'agent' || r.kind === 'gate');
    const seen = new Set<string>();
    return rows.filter((r) => !seen.has(r.id) && seen.add(r.id)).map((r) => {
      const task = store.task(r.task_id)!;
      const lastRow = store.lastRunEvent(r.id, 'message', 'tool', 'output');
      const last = lastRow ? parseEvent(lastRow) : null;
      const firstLine = (s: string) => { const l = s.split('\n').find((x) => x.trim()) ?? ''; return l.length > 120 ? l.slice(0, 117) + '…' : l; };
      const progress = r.progress ? (JSON.parse(r.progress) as Progress) : null;
      const now = progress?.did ? firstLine(progress.did) : last ? firstLine(last.text ?? `${last.name} ${last.summary}`) : null;
      return { ...runView(task, r), task: taskSummary(task), now };
    });
  };

  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const p = url.pathname;
    const m = (re: RegExp) => p.match(re);
    try {
      if (req.method === 'GET' && p === '/api/tasks') {
        const archived = url.searchParams.get('archived') === '1';
        return send(res, 200, store.tasks().filter((t) => !!t.archived_at === archived).map(taskSummary)), true;
      }
      if (req.method === 'POST' && p === '/api/tasks') {
        const b = await readJson(req);
        // A task needs a workspace, a repo path used once, or a workflow that names its own repo.
        const named = b.workspace ? pickWorkspace(store, { workspace: b.workspace }) : null;
        const workflow = b.workflow || named?.default_workflow;
        if (!workflow) return send(res, 400, { error: 'Say which workflow the task follows.' }), true;
        const workflowPath = resolveWorkflow(workflow);
        const wfRepo = (() => { try { return parseWorkflow(readFileSync(locateWorkflow(workflowPath), 'utf8')).repo; } catch { return undefined; } })();
        const ws = named ?? pickWorkspace(store, { repo: b.repo || wfRepo });
        const task = runner.startTask({ workflowPath, title: b.title, description: b.description, ref: b.ref, workspaceId: ws?.id, repo: ws ? undefined : b.repo, baseBranch: b.baseBranch });
        return send(res, 201, taskSummary(task)), true;
      }
      if (req.method === 'GET' && p === '/api/workspaces') return send(res, 200, store.workspaces().map(workspaceView)), true;
      if (req.method === 'POST' && p === '/api/workspaces') {
        const b = await readJson(req);
        return send(res, 201, workspaceView(createWorkspace(store, b))), true;
      }
      // The Add workspace form asks before you save: is this a git repo, and which branch is its default?
      if (req.method === 'GET' && p === '/api/workspaces/check') {
        const repo = (url.searchParams.get('repo') ?? '').trim();
        const dir = expandHome(repo);
        let ok = false;
        try { ok = !!repo && existsSync(dir) && execFileSync('git', ['-C', dir, 'rev-parse', '--verify', '-q', 'HEAD'], { stdio: 'pipe' }).length > 0; } catch { ok = false; }
        return send(res, 200, ok ? { ok, baseBranch: defaultBranch(dir) } : { ok, error: repo ? `${repo} is not a git repository with commits.` : 'Give a repo path.' }), true;
      }
      const wm = m(/^\/api\/workspaces\/([\w-]+)$/);
      if (wm) {
        if (req.method === 'GET') {
          const w = store.workspace(wm[1]);
          return send(res, w ? 200 : 404, w ? workspaceView(w) : { error: 'No such workspace' }), true;
        }
        if (req.method === 'PATCH') return send(res, 200, workspaceView(updateWorkspace(store, wm[1], await readJson(req)))), true;
        if (req.method === 'DELETE') return send(res, 200, { ok: true, unlinked: deleteWorkspace(store, wm[1]) }), true;
      }
      let mm = m(/^\/api\/tasks\/([\w-]+)$/);
      if (req.method === 'GET' && mm) {
        const t = store.task(mm[1]);
        const after = url.searchParams.get('after');
        return send(res, t ? 200 : 404, t ? taskDetail(t, { after: after !== null && after !== '' ? Number(after) : undefined }) : { error: 'No such task' }), true;
      }
      if ((mm = m(/^\/api\/tasks\/([\w-]+)\/(archive|unarchive)$/)) && req.method === 'POST') {
        runner.archive(mm[1], mm[2] === 'archive');
        return send(res, 200, { ok: true }), true;
      }
      if ((mm = m(/^\/api\/tasks\/([\w-]+)\/cleanup$/)) && req.method === 'POST') {
        const b = await readJson(req);
        return send(res, 200, { ok: true, text: runner.cleanup(mm[1], { force: b.force === true }) }), true;
      }
      if ((mm = m(/^\/api\/tasks\/([\w-]+)\/messages$/)) && req.method === 'POST') {
        const b = await readJson(req);
        const t = store.task(mm[1]);
        if (b.files?.length && !t?.worktree) return send(res, 400, { error: 'This task has no worktree, so it can carry no file.' }), true;
        // Attachments are checked against the worktree, so a browser cannot name a path Orstra never wrote.
        const files = b.files?.length ? checkAttachments(taskFiles(t!.worktree!), b.files) : [];
        await runner.message(mm[1], b.text ?? '', b.mode ?? 'chat', { runId: b.runId, stepId: b.stepId, files });
        return send(res, 200, { ok: true }), true;
      }
      // One pasted, dropped or picked file. It lands in the task's worktree, where the agent can read it.
      if ((mm = m(/^\/api\/tasks\/([\w-]+)\/attachments$/)) && req.method === 'POST') {
        const t = store.task(mm[1]);
        if (!t) return send(res, 404, { error: 'No such task' }), true;
        if (!t.worktree) return send(res, 400, { error: 'This task has no worktree yet, so a file has nowhere to go.' }), true;
        if (Number(req.headers['content-length'] ?? 0) > MAX_UPLOAD_BODY) {
          // Read the body and drop it. Without this the socket dies and the browser shows no sentence.
          req.resume();
          return send(res, 413, { error: `That file is over the cap of ${mb(MAX_FILE_BYTES)} per file.` }), true;
        }
        const b = await readJson(req);
        return send(res, 201, saveAttachment(taskFiles(t.worktree), { name: b.name, data: b.data })), true;
      }
      if ((mm = m(/^\/api\/tasks\/([\w-]+)\/attachment$/)) && req.method === 'GET') {
        const t = store.task(mm[1]);
        return sendAttachment(res, t?.worktree ? taskFiles(t.worktree) : null, url.searchParams.get('path') ?? '');
      }
      if ((mm = m(/^\/api\/tasks\/([\w-]+)\/retry$/)) && req.method === 'POST') {
        const b = await readJson(req);
        runner.retry(mm[1], b.stepId, b.note);
        return send(res, 200, { ok: true }), true;
      }
      if ((mm = m(/^\/api\/tasks\/([\w-]+)\/workflow\/refresh$/)) && req.method === 'POST') {
        runner.refreshWorkflow(mm[1]);
        return send(res, 200, { ok: true }), true;
      }
      if ((mm = m(/^\/api\/tasks\/([\w-]+)\/interrupt$/)) && req.method === 'POST') {
        runner.interrupt(mm[1]);
        return send(res, 200, { ok: true }), true;
      }
      if ((mm = m(/^\/api\/tasks\/([\w-]+)\/stop$/)) && req.method === 'POST') {
        runner.stop(mm[1]);
        return send(res, 200, { ok: true }), true;
      }
      if (req.method === 'POST' && p === '/api/rebuild') {
        const b = await readJson(req).catch(() => ({}));
        return send(res, 200, { changed: runner.rebuild(b.taskId) }), true;
      }
      // Permission questions from task agents (perm-mcp.ts asks; you answer in the UI).
      if (req.method === 'POST' && p === '/api/permissions') {
        const b = await readJson(req);
        return send(res, 200, runner.requestPermission(String(b.runId ?? ''), String(b.tool ?? 'unknown'), b.input && typeof b.input === 'object' ? b.input : {})), true;
      }
      if ((mm = m(/^\/api\/permissions\/([\w-]+)\/wait$/)) && req.method === 'POST') {
        return send(res, 200, { decision: await runner.waitPermission(mm[1]) }), true;
      }
      if ((mm = m(/^\/api\/permissions\/([\w-]+)\/answer$/)) && req.method === 'POST') {
        const b = await readJson(req);
        runner.answerPermission(mm[1], b.allow === true, { always: b.always === true, message: typeof b.message === 'string' ? b.message : undefined });
        return send(res, 200, { ok: true }), true;
      }
      if ((mm = m(/^\/api\/runs\/([\w-]+)\/decide$/)) && req.method === 'POST') {
        const b = await readJson(req);
        runner.decide(mm[1], b.choice, b.comment);
        return send(res, 200, { ok: true }), true;
      }
      if ((mm = m(/^\/api\/tasks\/([\w-]+)\/git$/)) && req.method === 'GET') {
        const t = store.task(mm[1]);
        return send(res, t ? 200 : 404, t ? gitView(t) : { error: 'No such task' }), true;
      }
      if ((mm = m(/^\/api\/artifacts\/([\w-]+)$/)) && req.method === 'GET') {
        const a = store.artifact(mm[1]);
        // Only files Orstra itself copied into the store, and only from inside it.
        const file = a?.path ? resolve(a.path) : null;
        if (!a || a.state !== 'saved' || !file || !file.startsWith(resolve(ARTIFACTS) + sep) || !existsSync(file)) {
          return send(res, 404, { error: 'No such artifact' }), true;
        }
        res.writeHead(200, {
          'content-type': a.mime,
          'content-length': String(statSync(file).size),
          'content-disposition': `inline; filename="${a.name.replace(/["\\]/g, '')}"`,
          'cache-control': 'private, max-age=31536000, immutable',
        });
        return res.end(readFileSync(file)), true;
      }
      if ((mm = m(/^\/api\/tasks\/([\w-]+)\/diff$/)) && req.method === 'GET') {
        const t = store.task(mm[1]);
        const d = t?.worktree ? gitDiff(t.worktree, url.searchParams.get('path') ?? '', { branch: t.base_branch ?? null, commit: t.base_commit ?? null }) : null;
        return send(res, d ? 200 : 404, d ?? { error: 'No diff for that file' }), true;
      }
      // The side viewer: the worktree's files, and one file's bytes.
      if ((mm = m(/^\/api\/tasks\/([\w-]+)\/files$/)) && req.method === 'GET') {
        const t = store.task(mm[1]);
        if (!t?.worktree || !existsSync(t.worktree)) return send(res, 404, { error: 'This task has no worktree now.' }), true;
        return send(res, 200, listFiles(t.worktree)), true;
      }
      if ((mm = m(/^\/api\/tasks\/([\w-]+)\/file$/)) && req.method === 'GET') {
        const t = store.task(mm[1]);
        if (!t) return send(res, 404, { error: 'No such task' }), true;
        // The worktree first, then the repositories the task's agents read or edited files in.
        const touched = store.eventsOfKind(t.id, 'tool').map((e) => JSON.parse(e.payload) as { name?: string; summary?: string })
          .filter((e) => /^(read|write|edit|multiedit|notebookedit)$/i.test(e.name ?? '') && e.summary?.startsWith('/') && !e.summary.endsWith('…'))
          .map((e) => e.summary!);
        // Newest first: when 2 repositories have the same path, the one the agent used last wins.
        const roots = [...(t.worktree ? [t.worktree] : []), ...agentRoots([...new Set(touched.reverse())])];
        const hit = readTaskFile(roots, url.searchParams.get('path') ?? '');
        if (!hit) return send(res, 404, { error: 'This file is not in the task’s worktree, or in a repository its agent worked in.' }), true;
        // The agent may change the file at any time, so the browser asks again each time.
        return sendBytes(res, hit, 'no-store');
      }
      // Terminals: a shell in the task's worktree. Output streams from /stream (in startServer).
      if ((mm = m(/^\/api\/tasks\/([\w-]+)\/terminals$/))) {
        const t = store.task(mm[1]);
        if (!t) return send(res, 404, { error: 'No such task' }), true;
        if (req.method === 'GET') return send(res, 200, terminals.list(t.id)), true;
        if (req.method === 'POST') {
          if (!t.worktree || !existsSync(t.worktree)) return send(res, 400, { error: 'This task has no worktree yet.' }), true;
          try {
            return send(res, 201, await terminals.open(t.id, t.worktree)), true;
          } catch (err: any) {
            return send(res, 503, { error: err?.message ?? String(err) }), true;
          }
        }
      }
      if ((mm = m(/^\/api\/terminals\/([\w-]+)\/(input|resize|close)$/)) && req.method === 'POST') {
        if (!terminals.get(mm[1])) return req.resume(), send(res, 404, { error: 'No such terminal' }), true;
        if (Number(req.headers['content-length'] ?? 0) > MAX_INPUT_BODY) return req.resume(), send(res, 413, { error: 'Too much input at once.' }), true;
        const b = await readJson(req);
        if (mm[2] === 'input' && typeof b.data === 'string') terminals.write(mm[1], b.data);
        if (mm[2] === 'resize') terminals.resize(mm[1], Number(b.cols), Number(b.rows));
        if (mm[2] === 'close') terminals.close(mm[1]);
        return send(res, 200, { ok: true }), true;
      }
      // The task's dev server, for the Browser panel.
      if ((mm = m(/^\/api\/tasks\/([\w-]+)\/devserver(?:\/(start|stop))?$/))) {
        const t = store.task(mm[1]);
        if (!t) return send(res, 404, { error: 'No such task' }), true;
        if (req.method === 'GET' && !mm[2]) return send(res, 200, devServers.status(t.id, t.worktree)), true;
        if (req.method === 'POST' && mm[2] === 'stop') return await devServers.stop(t.id), send(res, 200, devServers.status(t.id, t.worktree)), true;
        if (req.method === 'POST' && mm[2] === 'start') {
          if (!t.worktree || !existsSync(t.worktree)) return send(res, 400, { error: 'This task has no worktree yet.' }), true;
          const b = await readJson(req);
          const command = (typeof b.command === 'string' && b.command.trim()) || devServers.status(t.id, t.worktree).suggested;
          if (!command) return send(res, 400, { error: 'Say which command starts the dev server. The worktree has no dev or start script.' }), true;
          return send(res, 200, await devServers.start(t.id, t.worktree, command)), true;
        }
      }
      if (req.method === 'GET' && p === '/api/link-info') return send(res, 200, await linkInfo(url.searchParams.get('url') ?? '')), true;
      if ((mm = m(/^\/api\/workflows\/([^/]+)$/)) && req.method === 'PUT') {
        const file = decodeURIComponent(mm[1]);
        const hit = listWorkflows().find((w) => w.file === file);
        if (!hit) return send(res, 404, { error: 'No such workflow' }), true;
        const graph = (await readJson(req)) as EditGraph;
        // Validates first (throws a readable message), then swaps the file in atomically.
        const next = applyEdits(readFileSync(hit.path, 'utf8'), graph);
        const tmp = `${hit.path}.orstra-tmp`;
        writeFileSync(tmp, next);
        renameSync(tmp, hit.path);
        runner.forgetWorkflow(hit.path);
        return send(res, 200, workflowDetail(file)), true;
      }
      if ((mm = m(/^\/api\/workflows\/([^/]+)$/)) && req.method === 'GET') {
        const w = workflowDetail(decodeURIComponent(mm[1]));
        return send(res, w ? 200 : 404, w ?? { error: 'No such workflow' }), true;
      }
      if (p.startsWith('/api/cos')) {
        if (!cos) return send(res, 404, { error: 'The assistant isn’t running.' }), true;
        if (req.method === 'GET' && p === '/api/cos') return send(res, 200, cos.view()), true;
        if (req.method === 'POST' && p === '/api/cos/messages') {
          const b = await readJson(req);
          cos.say(String(b.text ?? ''), checkAttachments(cosFiles(COS_DIR), b.files));
          return send(res, 200, { ok: true }), true;
        }
        // The chief of staff keeps its files in its own folder, the one its session works in.
        if (req.method === 'POST' && p === '/api/cos/attachments') {
          if (Number(req.headers['content-length'] ?? 0) > MAX_UPLOAD_BODY) {
            req.resume();
            return send(res, 413, { error: `That file is over the cap of ${mb(MAX_FILE_BYTES)} per file.` }), true;
          }
          const b = await readJson(req);
          return send(res, 201, saveAttachment(cosFiles(COS_DIR), { name: b.name, data: b.data })), true;
        }
        if (req.method === 'GET' && p === '/api/cos/attachment') {
          return sendAttachment(res, cosFiles(COS_DIR), url.searchParams.get('path') ?? '');
        }
        if (req.method === 'POST' && p === '/api/cos/interrupt') return cos.interrupt(), send(res, 200, { ok: true }), true;
        if (req.method === 'POST' && p === '/api/cos/tool') {
          const b = await readJson(req);
          try {
            return send(res, 200, { text: await cos.tool(String(b.name), b.args ?? {}) }), true;
          } catch (err: any) {
            return send(res, 400, { error: err?.message ?? String(err) }), true;
          }
        }
        if (req.method === 'POST' && p === '/api/cos/permissions') {
          const b = await readJson(req);
          cos.setPermission(b.key, !!b.value);
          return send(res, 200, { ok: true }), true;
        }
        if ((mm = m(/^\/api\/cos\/plans\/([\w-]+)\/(approve|decline)$/)) && req.method === 'POST') {
          if (mm[2] === 'approve') await cos.approve(mm[1]);
          else cos.decline(mm[1]);
          return send(res, 200, { ok: true }), true;
        }
        if ((mm = m(/^\/api\/cos\/watches\/([\w-]+)\/remove$/)) && req.method === 'POST') return cos.removeWatch(mm[1]), send(res, 200, { ok: true }), true;
      }
      if (req.method === 'GET' && p === '/api/settings') {
        return send(res, 200, { home: HOME, database: DB_PATH, worktrees: WORKTREES, workflowDirs: WORKFLOW_DIRS, port: PORT, slots: SLOTS, agents: agents(), agentConfig: loadAgentConfig(), efforts: EFFORTS,
          triggers: triggers?.view() ?? [], linear: !!process.env.LINEAR_API_KEY,
          cost: { today: store.costSince(new Date().setHours(0, 0, 0, 0)), week: store.costSince(Date.now() - 7 * 86400_000) }, permissionModes: PERMISSION_MODES, envPermissionMode: process.env.ORSTRA_CLAUDE_PERMISSION ?? null }), true;
      }
      if ((mm = m(/^\/api\/settings\/agents\/([\w-]+)$/)) && req.method === 'PUT') {
        if (!AGENT_IDS.includes(mm[1] as AgentId)) return send(res, 404, { error: 'No such agent' }), true;
        return send(res, 200, saveAgentSettings(mm[1] as AgentId, await readJson(req))), true;
      }
      if (req.method === 'GET' && p === '/api/sessions') return send(res, 200, sessions()), true;
      if (req.method === 'GET' && p === '/api/inbox') return send(res, 200, store.tasks().filter((t) => t.status === 'needs_you' && !t.archived_at).map((t) => taskDetail(t, { events: false }))), true;
      if (req.method === 'GET' && p === '/api/workflows') return send(res, 200, listWorkflows()), true;
    } catch (err: any) {
      return send(res, 400, { error: err?.message ?? String(err) }), true;
    }
    return false;
  };
}

/** How often the event stream sends a beat when nothing changes. */
export const HEARTBEAT_MS = 15_000;

export function startServer(store: Store, runner: Runner, port: number, cos?: ChiefOfStaff, triggers?: Triggers, extras: ServerExtras = {}) {
  const terminals = extras.terminals ?? new Terminals();
  const devServers = extras.devServers ?? new DevServers();
  const api = buildApi(store, runner, cos, triggers, { ...extras, terminals, devServers });
  const clients = new Set<ServerResponse>();
  /** Writes one block to every open stream and drops the streams that went away. */
  const write = (block: string) => {
    for (const c of clients) {
      if (c.writableEnded || c.destroyed) {
        clients.delete(c);
        continue;
      }
      try {
        c.write(block);
      } catch {
        clients.delete(c);
      }
    }
  };
  const broadcast = (e: unknown) => write(`data: ${JSON.stringify(e)}\n\n`);
  // A named event, so the browser does not hand it to onmessage: a beat means "the stream is alive",
  // not "refetch". Without it a stream that died quietly looks the same as one with nothing to say,
  // and the UI stops updating until you reload the page.
  const beat = setInterval(() => write('event: ping\ndata: {"ping":true}\n\n'), extras.heartbeatMs ?? HEARTBEAT_MS);
  beat.unref();
  // An agent can stream many events a second. Send each task's change at most once per 100 ms,
  // so the UI refetches once for a burst and not once per line.
  const pending = new Set<string>();
  let flush: NodeJS.Timeout | null = null;
  runner.on('change', (e: { taskId: string }) => {
    cos?.onTaskChange(e.taskId);
    pending.add(e.taskId);
    flush ??= setTimeout(() => {
      flush = null;
      const ids = [...pending];
      pending.clear();
      for (const taskId of ids) broadcast({ taskId });
    }, 100);
  });
  cos?.on('change', broadcast);
  devServers.on('change', (taskId: string) => broadcast({ taskId }));
  runner.on('cleanup', (taskId: string) => {
    terminals.closeTask(taskId);
    // The worktree goes right after this: no grace period, so nothing writes into it again.
    devServers.kill(taskId);
  });

  // The port the server really has (port 0 in tests means "any free one").
  let guard = guardOptionsFromEnv(port);
  const server = createServer(async (req, res) => {
    if (req.url?.startsWith('/api/')) {
      const why = refuseReason(req.method, req.headers, guard);
      // why is null for a request from Orstra's UI, the CLI or an MCP server.
      if (why) {
        req.resume();
        return send(res, 403, { error: `Refused: ${why}` });
      }
    }
    if (req.url === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      // Send each small block as it is written; an agent's lines are worth nothing once they are late.
      res.socket?.setNoDelay(true);
      res.flushHeaders();
      res.write(': connected\n\n');
      clients.add(res);
      const drop = () => clients.delete(res);
      req.on('close', drop);
      res.on('close', drop);
      res.on('error', drop);
      return;
    }
    // One terminal's output: what it kept, then each new chunk, as JSON events.
    const tm = req.method === 'GET' ? /^\/api\/terminals\/([\w-]+)\/stream$/.exec(req.url ?? '') : null;
    if (tm) {
      const term = terminals.get(tm[1]);
      if (!term) return send(res, 404, { error: 'No such terminal' });
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      // A terminal's output is worth nothing once it is late, and a reader that went away must not
      // take the daemon down. The same 2 rules as /api/events above.
      res.socket?.setNoDelay(true);
      res.flushHeaders();
      const put = (block: string) => {
        if (res.writableEnded || res.destroyed) return false;
        try {
          res.write(block);
          return true;
        } catch {
          return false;
        }
      };
      const out = (e: unknown) => put(`data: ${JSON.stringify(e)}\n\n`);
      out({ type: 'data', data: term.scrollback });
      const onData = (id: string, data: string) => id === term.id && out({ type: 'data', data });
      const onExit = (id: string, code: number) => id === term.id && (out({ type: 'exit', code }), res.end());
      terminals.on('data', onData);
      terminals.on('exit', onExit);
      // A shell can sit idle for hours. The beat keeps the connection from dying quietly; it is a
      // named event, so the browser never hands it to onmessage.
      const idle = setInterval(() => put('event: ping\ndata: {"ping":true}\n\n'), extras.heartbeatMs ?? HEARTBEAT_MS);
      idle.unref();
      const done = () => {
        clearInterval(idle);
        terminals.off('data', onData);
        terminals.off('exit', onExit);
      };
      req.on('close', done);
      res.on('close', done);
      res.on('error', done);
      return;
    }
    if (await api(req, res)) return;
    if (req.url?.startsWith('/api/')) return send(res, 404, { error: 'Not found' });

    // Serve the built UI, falling back to index.html for client-side routes.
    if (!existsSync(WEB_DIST)) {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('Orstra daemon is running. Start the UI with `npm run dev` (web) or build it with `npm run build`.');
    }
    const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
    let file = join(WEB_DIST, urlPath);
    if (!file.startsWith(WEB_DIST) || !existsSync(file) || statSync(file).isDirectory()) file = join(WEB_DIST, 'index.html');
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  server.on('listening', () => {
    const addr = server.address();
    if (addr && typeof addr === 'object') guard = guardOptionsFromEnv(addr.port);
  });
  server.on('close', () => {
    clearInterval(beat);
    if (flush) clearTimeout(flush);
  });
  server.listen(port, '127.0.0.1');
  return server;
}
