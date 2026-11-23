import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, extname, join, resolve } from 'node:path';
import { parseWorkflow, taskPath, type Progress, type Workflow } from '@orstra/core';
import type { EventRow, RunRow, Store, TaskRow } from './db.ts';
import type { Runner } from './runner.ts';
import { gitDiff, gitInfo } from './git.ts';
import { DB_PATH, HOME, PORT, SLOTS, WEB_DIST, WORKFLOW_DIRS, WORKTREES } from './paths.ts';

const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png' };

function send(res: ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<any> {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

export function listWorkflows(): { name: string; path: string; file: string; error?: string }[] {
  const out: { name: string; path: string; file: string; error?: string }[] = [];
  for (const dir of WORKFLOW_DIRS) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!/\.ya?ml$/.test(f)) continue;
      const path = join(dir, f);
      const m = readFileSync(path, 'utf8').match(/^name:\s*(.+)$/m);
      out.push({ name: m?.[1]?.trim() ?? f, path, file: f });
    }
  }
  return out;
}

export function resolveWorkflow(nameOrPath: string): string {
  if (existsSync(nameOrPath) && statSync(nameOrPath).isFile()) return resolve(nameOrPath);
  const hit = listWorkflows().find((w) => w.file === nameOrPath || w.file.replace(/\.ya?ml$/, '') === nameOrPath || w.name === nameOrPath);
  if (!hit) throw new Error(`No workflow called "${nameOrPath}". Put YAML files in ${WORKFLOW_DIRS.join(' or ')}.`);
  return hit.path;
}

function workflowView(wf: Workflow) {
  return {
    name: wf.name, description: wf.description ?? null, repo: wf.repo ?? null, start: wf.start, concurrency: wf.concurrency,
    steps: Object.values(wf.steps).map((s) => ({
      id: s.id, title: s.title ?? s.id, kind: s.use, agent: s.agent ?? null, model: s.model ?? null, prompt: s.prompt ?? null, run: s.run ?? null,
      question: s.question ?? null, action: s.action ?? null,
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
    return { file: hit.file, path: hit.path, yaml, error: err?.message ?? String(err), name: hit.name, description: null, repo: null, start: null, concurrency: null, steps: [] };
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

export function buildApi(store: Store, runner: Runner) {
  const stepTitle = (task: TaskRow, stepId: string) => {
    try { return runner.workflow(task.workflow_path).steps[stepId]?.title ?? stepId; } catch { return stepId; }
  };

  const runView = (task: TaskRow, r: RunRow) => ({
    id: r.id, taskId: r.task_id, stepId: r.step_id, stepTitle: stepTitle(task, r.step_id), kind: r.kind, attempt: r.attempt,
    status: r.status, outcome: r.outcome, agent: r.agent, sessionId: r.session_id,
    progress: r.progress ? (JSON.parse(r.progress) as Progress) : null, output: r.output,
    createdAt: r.created_at, startedAt: r.started_at, endedAt: r.ended_at,
    openCommand: r.session_id && task.worktree ? `cd ${task.worktree} && claude --resume ${r.session_id}` : null,
    forkCommand: r.session_id && task.worktree ? `cd ${task.worktree} && claude --resume ${r.session_id} --fork-session` : null,
    live: runner.isLive(r.id),
  });

  const taskSummary = (t: TaskRow) => {
    const runs = store.runsForTask(t.id);
    // The run that says where the task is: the latest one at its current step, else its latest run.
    const cur = (t.current_step ? [...runs].reverse().find((r) => r.step_id === t.current_step) : undefined) ?? runs[runs.length - 1];
    const lastAgent = [...runs].reverse().find((r) => r.kind === 'agent');
    return {
      id: t.id, ref: t.ref, title: t.title, workflow: t.workflow_name, workflowFile: basename(t.workflow_path), status: t.status, currentStep: t.current_step,
      currentStepTitle: t.current_step ? stepTitle(t, t.current_step) : null, inboxReason: t.inbox_reason,
      run: cur ? { status: cur.status, attempt: cur.attempt, kind: cur.kind } : null, agent: lastAgent?.agent ?? null,
      createdAt: t.created_at, updatedAt: t.updated_at,
    };
  };

  const taskDetail = (t: TaskRow) => {
    const runs = store.runsForTask(t.id).map((r) => runView(t, r));
    let steps: { id: string; title: string; kind: string; agent: string | null; on: Record<string, string> }[] = [];
    let human: unknown = null;
    let track: { id: string; title: string; kind: string; state: 'done' | 'current' | 'todo' }[] = [];
    try {
      const wf = runner.workflow(t.workflow_path);
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
        human = { runId: waiting.id, question: step.question ?? 'Decide', choices: Object.keys(step.on), artifact: lastAgent ? { step: lastAgent.stepTitle, progress: lastAgent.progress } : null };
      }
    } catch (err) {
      steps = [];
    }
    const events = store.events(t.id).map(parseEvent);
    // An agent run that is waiting on you: it asked a question, answered you, or you stopped it.
    const agentWaiting = runs.find((r) => r.status === 'waiting' && r.kind === 'agent');
    const lastMsg = agentWaiting ? [...events].reverse().find((e) => e.runId === agentWaiting.id && e.kind === 'message') : null;
    const awaiting = agentWaiting ? { runId: agentWaiting.id, reason: t.inbox_reason, text: lastMsg?.text ?? null } : null;
    const working = runs.find((r) => r.kind === 'agent' && r.status === 'running' && r.live) ?? null;
    // Notes waiting for a step: written since that step last started, so its next run will read them.
    const notes: Record<string, { text: string; ts: number }[]> = {};
    for (const e of events) {
      if (e.kind !== 'note' || !e.step) continue;
      const lastRun = [...runs].reverse().find((r) => r.stepId === e.step);
      if (lastRun && e.ts < lastRun.createdAt) continue;
      (notes[e.step] ??= []).push({ text: e.text, ts: e.ts });
    }
    return { ...taskSummary(t), description: t.description, worktree: t.worktree, steps, track, notes, runs, human, awaiting, workingRunId: working?.id ?? null, events };
  };

  /** The task's worktree as a coding tool would show it: branch, changes, commits, and the checks that ran. */
  const gitView = (t: TaskRow) => {
    const info = t.worktree ? gitInfo(t.worktree) : null;
    const checks = store.runsForTask(t.id).filter((r) => r.kind === 'gate').reverse().map((r) => ({
      runId: r.id, name: stepTitle(t, r.step_id) + (r.attempt > 1 ? ` · attempt ${r.attempt}` : ''),
      state: r.status === 'running' || r.status === 'queued' ? 'running' : r.outcome === 'pass' ? 'pass' : r.status === 'stopped' ? 'stopped' : 'fail',
      detail: (r.output ?? '').trim().split('\n').slice(-8).join('\n'), endedAt: r.ended_at,
    }));
    return { worktree: t.worktree, branch: info?.branch ?? null, base: info?.base ?? null, ahead: info?.ahead ?? 0, uncommitted: info?.uncommitted ?? 0,
      files: info?.files ?? [], commits: info?.commits ?? [], checks, pr: null as null | { number: number; url: string; state: string } };
  };

  const sessions = () => {
    const since = Date.now() - 24 * 3600_000;
    const rows = [...store.runsByStatus('running', 'waiting', 'queued'), ...store.runsSince(since).filter((r) => !['running', 'queued', 'waiting'].includes(r.status))]
      .filter((r) => r.kind === 'agent' || r.kind === 'gate');
    const seen = new Set<string>();
    return rows.filter((r) => !seen.has(r.id) && seen.add(r.id)).map((r) => {
      const task = store.task(r.task_id)!;
      const evs = store.events(r.task_id).filter((e) => e.run_id === r.id && ['message', 'tool', 'output'].includes(e.kind));
      const last = evs.length ? parseEvent(evs[evs.length - 1]) : null;
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
      if (req.method === 'GET' && p === '/api/tasks') return send(res, 200, store.tasks().map(taskSummary)), true;
      if (req.method === 'POST' && p === '/api/tasks') {
        const b = await readJson(req);
        const task = runner.startTask({ workflowPath: resolveWorkflow(b.workflow), title: b.title, description: b.description, ref: b.ref, repo: b.repo });
        return send(res, 201, taskSummary(task)), true;
      }
      let mm = m(/^\/api\/tasks\/([\w-]+)$/);
      if (req.method === 'GET' && mm) {
        const t = store.task(mm[1]);
        return send(res, t ? 200 : 404, t ? taskDetail(t) : { error: 'No such task' }), true;
      }
      if ((mm = m(/^\/api\/tasks\/([\w-]+)\/messages$/)) && req.method === 'POST') {
        const b = await readJson(req);
        await runner.message(mm[1], b.text, b.mode ?? 'chat', { runId: b.runId, stepId: b.stepId });
        return send(res, 200, { ok: true }), true;
      }
      if ((mm = m(/^\/api\/tasks\/([\w-]+)\/retry$/)) && req.method === 'POST') {
        const b = await readJson(req);
        runner.retry(mm[1], b.stepId, b.note);
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
      if ((mm = m(/^\/api\/runs\/([\w-]+)\/decide$/)) && req.method === 'POST') {
        const b = await readJson(req);
        runner.decide(mm[1], b.choice, b.comment);
        return send(res, 200, { ok: true }), true;
      }
      if ((mm = m(/^\/api\/tasks\/([\w-]+)\/git$/)) && req.method === 'GET') {
        const t = store.task(mm[1]);
        return send(res, t ? 200 : 404, t ? gitView(t) : { error: 'No such task' }), true;
      }
      if ((mm = m(/^\/api\/tasks\/([\w-]+)\/diff$/)) && req.method === 'GET') {
        const t = store.task(mm[1]);
        const d = t?.worktree ? gitDiff(t.worktree, url.searchParams.get('path') ?? '') : null;
        return send(res, d ? 200 : 404, d ?? { error: 'No diff for that file' }), true;
      }
      if ((mm = m(/^\/api\/workflows\/([^/]+)$/)) && req.method === 'GET') {
        const w = workflowDetail(decodeURIComponent(mm[1]));
        return send(res, w ? 200 : 404, w ?? { error: 'No such workflow' }), true;
      }
      if (req.method === 'GET' && p === '/api/settings') {
        return send(res, 200, { home: HOME, database: DB_PATH, worktrees: WORKTREES, workflowDirs: WORKFLOW_DIRS, port: PORT, slots: SLOTS, agents: agents() }), true;
      }
      if (req.method === 'GET' && p === '/api/sessions') return send(res, 200, sessions()), true;
      if (req.method === 'GET' && p === '/api/inbox') return send(res, 200, store.tasks().filter((t) => t.status === 'needs_you').map(taskDetail)), true;
      if (req.method === 'GET' && p === '/api/workflows') return send(res, 200, listWorkflows()), true;
    } catch (err: any) {
      return send(res, 400, { error: err?.message ?? String(err) }), true;
    }
    return false;
  };
}

export function startServer(store: Store, runner: Runner, port: number) {
  const api = buildApi(store, runner);
  const clients = new Set<ServerResponse>();
  runner.on('change', (e) => {
    const line = `data: ${JSON.stringify(e)}\n\n`;
    for (const c of clients) c.write(line);
  });

  const server = createServer(async (req, res) => {
    if (req.url === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(': connected\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
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
  server.listen(port, '127.0.0.1');
  return server;
}
