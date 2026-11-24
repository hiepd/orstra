// Types and calls for the Orstra daemon API (proxied at /api in dev, same origin in prod).

export type Progress = { did: string; decided?: string; left?: string; avoid?: string };

export type TaskStatus = 'running' | 'needs_you' | 'done' | 'stopped';
export type RunStatus = 'queued' | 'running' | 'waiting' | 'done' | 'failed' | 'stopped';
/**
 * Where a task stands, as the daemon works it out from the task's runs. Declared again here because
 * the web app does not depend on @orstra/core; `taskState` falls back when the 2 lists drift.
 */
export type TaskState = 'queued' | 'working' | 'checks' | 'waiting_you' | 'paused' | 'decision' | 'blocked' | 'done' | 'stopped';
export type StepKind = 'agent' | 'gate' | 'human' | 'switch' | 'action' | 'workflow';
export type AgentName = 'claude-code' | 'codex';
export type MessageMode = 'chat' | 'note' | 'ask';

export interface TaskSummary {
  id: string;
  ref: string | null;
  title: string;
  workflow: string;
  status: TaskStatus;
  state: TaskState;
  /** The wait reason or the block reason behind `state`. */
  stateReason: string | null;
  /** When the agent's turn last ended on the open run. */
  lastTurnAt: number | null;
  currentStep: string | null;
  currentStepTitle: string | null;
  inboxReason: string | null;
  workflowFile: string;
  /** The run that says where the task is right now. */
  run: { status: RunStatus; attempt: number; kind: StepKind } | null;
  /** The agent of the task's latest agent run. */
  agent: AgentName | null;
  createdAt: number;
  updatedAt: number;
}

export interface RunView {
  id: string;
  taskId: string;
  stepId: string;
  stepTitle: string;
  kind: StepKind;
  attempt: number;
  status: RunStatus;
  outcome: string | null;
  agent: AgentName | null;
  sessionId: string | null;
  progress: Progress | null;
  output: string | null;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  openCommand: string | null;
  forkCommand: string | null;
  /** The session process is running right now. */
  live?: boolean;
}

export interface StepView {
  id: string;
  title: string;
  kind: StepKind;
  agent: AgentName | null;
  on: Record<string, string>;
}

export interface HumanDecision {
  runId: string;
  question: string;
  choices: string[];
  artifact: null | { step: string; progress: Progress };
}

/**
 * A file you added to a message. It sits in the task's worktree at `path`, so the agent reads it
 * from there. A file a step produces is an artifact, not an attachment.
 */
export interface ChatFile {
  name: string;
  /** Relative to the worktree: `.orstra/attachments/<id>/<name>`. */
  path: string;
  bytes: number;
  mime: string;
}

interface EventBase {
  id: number | string;
  runId: string | null;
  ts: number;
}

export type TaskEvent = EventBase &
  (
    | { kind: 'system'; text: string }
    | { kind: 'message'; text: string }
    | { kind: 'tool'; name: string; summary: string }
    | { kind: 'output'; text: string }
    | ({ kind: 'progress' } & Progress)
    // 'steer' is a legacy mode from older events; treat it like 'chat'.
    | { kind: 'you'; mode: MessageMode | 'decision' | 'interrupt' | 'steer'; text: string; choice?: string; step?: string | null; via?: 'cos'; files?: ChatFile[] }
    | { kind: 'note'; text: string; step?: string }
    | { kind: 'aside'; text: string }
  );

export type AwaitingReason = 'question' | 'reply' | 'paused' | 'restarted';

/** An agent run waiting on you: it asked something, answered you, you stopped it, or Orstra restarted. */
export interface Awaiting {
  runId: string;
  reason: AwaitingReason | string | null;
  text: string | null;
}

export interface TaskDetail extends TaskSummary {
  description: string | null;
  worktree: string | null;
  steps: StepView[];
  /** The steps this task has been through, then the ones it will most likely reach. */
  track: TrackStep[];
  /** Notes waiting for a step's next run, by step id. */
  notes: Record<string, { text: string; ts: number }[]>;
  runs: RunView[];
  human: HumanDecision | null;
  awaiting?: Awaiting | null;
  workingRunId?: string | null;
  events: TaskEvent[];
}

export interface TrackStep {
  id: string;
  title: string;
  kind: StepKind;
  state: 'done' | 'current' | 'todo';
}

export interface ChangedFile {
  path: string;
  status: 'A' | 'M' | 'D' | 'R';
  add: number;
  del: number;
  uncommitted: boolean;
}

export interface Check {
  runId: string;
  name: string;
  state: 'running' | 'pass' | 'fail' | 'stopped';
  detail: string;
  endedAt: number | null;
}

/** A task's worktree: branch, what changed compared with where it started, commits and checks. */
export interface GitView {
  worktree: string | null;
  branch: string | null;
  base: string | null;
  ahead: number;
  uncommitted: number;
  files: ChangedFile[];
  commits: { sha: string; message: string; ts: number }[];
  checks: Check[];
  pr: null | { number: number; url: string; state: string };
}

export interface FileDiff {
  path: string;
  diff: string;
  truncated: boolean;
}

export interface WorkflowStep {
  id: string;
  title: string;
  kind: StepKind;
  agent: AgentName | null;
  model: string | null;
  prompt: string | null;
  run: string[] | null;
  question: string | null;
  choices: string[] | null;
  value: string | null;
  action: string | null;
  workflow: string | null;
  on: { outcome: string; to: string; toTitle: string; max: number | null }[];
}

export interface WorkflowDetail {
  file: string;
  path: string;
  yaml: string;
  error: string | null;
  name: string;
  description: string | null;
  repo: string | null;
  start: string | null;
  concurrency: number | null;
  /** Saved canvas positions: step id -> [x, y]. */
  layout: Record<string, [number, number]>;
  steps: WorkflowStep[];
}

/** What the editor saves: the whole graph. The daemon applies it to the YAML file. */
export interface WorkflowGraphInput {
  start: string;
  steps: {
    id: string;
    kind: StepKind;
    title?: string;
    agent?: AgentName;
    model?: string;
    prompt?: string;
    run?: string[];
    question?: string;
    choices?: string[];
    value?: string;
    action?: string;
    workflow?: string;
    on: { outcome: string; to: string; max: number | null }[];
  }[];
  layout: Record<string, [number, number]>;
}

export interface Settings {
  home: string;
  database: string;
  worktrees: string;
  workflowDirs: string[];
  port: number;
  slots: number;
  agents: { id: AgentName; name: string; command: string; path: string | null }[];
  agentConfig: Record<AgentName, AgentSettings>;
  efforts: string[];
  permissionModes: string[];
  /** Set when ORSTRA_CLAUDE_PERMISSION is in the daemon's environment (used when no mode is chosen here). */
  envPermissionMode: string | null;
}

/** Per-agent defaults saved in ~/.orstra/agents.json. A missing field means the agent's own default. */
export interface AgentSettings {
  model?: string;
  effort?: string;
  permissionMode?: string;
}

/** One entry in the chief of staff conversation. */
export type CosEvent = { id: number; ts: number } & (
  | { kind: 'you'; text: string; files?: ChatFile[] }
  | { kind: 'message'; text: string }
  | { kind: 'tool'; name: string; summary: string }
  | { kind: 'show'; title: string; taskIds: string[] }
  | { kind: 'plan'; planId: string }
  | { kind: 'did'; text: string; taskId: string | null; view?: 'chat' | null; watch?: boolean }
  | { kind: 'system'; text: string }
);

export interface CosPlan {
  id: string;
  status: 'pending' | 'approved' | 'declined';
  actions: string[];
  results: string[] | null;
}

export interface CosWatch {
  id: string;
  taskId: string;
  task: string;
  title: string;
  until: 'done' | 'needs_you' | 'stopped' | 'finished';
  instruction: string;
  createdAt: number;
}

export type CosPermission = 'msg' | 'start';

export interface CosView {
  working: boolean;
  events: CosEvent[];
  plans: CosPlan[];
  watches: CosWatch[];
  permissions: Record<CosPermission, boolean>;
}

export interface WorkflowInfo {
  name: string;
  path: string;
  file: string;
  error?: string;
}

export interface NewTaskInput {
  workflow: string;
  title: string;
  description?: string;
  ref?: string;
  repo?: string;
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function request<T>(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError('Can’t reach the Orstra daemon. Is it running on port 4317?', 0);
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    if (!res.ok) throw new ApiError(`Request failed (${res.status})`, res.status);
    throw new ApiError('The daemon sent a response the UI couldn’t read.', res.status);
  }
  if (!res.ok) {
    const msg = data && typeof data === 'object' && 'error' in data ? String((data as { error: unknown }).error) : `Request failed (${res.status})`;
    throw new ApiError(msg, res.status);
  }
  return data as T;
}

export const api = {
  tasks: () => request<TaskSummary[]>('GET', '/api/tasks'),
  task: (id: string) => request<TaskDetail>('GET', `/api/tasks/${encodeURIComponent(id)}`),
  inbox: () => request<TaskDetail[]>('GET', '/api/inbox'),
  workflows: () => request<WorkflowInfo[]>('GET', '/api/workflows'),
  workflow: (file: string) => request<WorkflowDetail>('GET', `/api/workflows/${encodeURIComponent(file)}`),
  settings: () => request<Settings>('GET', '/api/settings'),
  saveAgentSettings: (agent: AgentName, body: AgentSettings) => request<Record<AgentName, AgentSettings>>('PUT', `/api/settings/agents/${encodeURIComponent(agent)}`, body),
  cos: () => request<CosView>('GET', '/api/cos'),
  cosSay: (text: string, files?: ChatFile[]) => request<{ ok: true }>('POST', '/api/cos/messages', { text, files }),
  /** Put one file in the chief of staff's own folder, the one its session works in. */
  cosAttach: (body: { name: string; data: string }) => request<ChatFile>('POST', '/api/cos/attachments', body),
  cosInterrupt: () => request<{ ok: true }>('POST', '/api/cos/interrupt'),
  cosPlan: (id: string, answer: 'approve' | 'decline') => request<{ ok: true }>('POST', `/api/cos/plans/${encodeURIComponent(id)}/${answer}`),
  cosUnwatch: (id: string) => request<{ ok: true }>('POST', `/api/cos/watches/${encodeURIComponent(id)}/remove`),
  cosPermission: (key: CosPermission, value: boolean) => request<{ ok: true }>('POST', '/api/cos/permissions', { key, value }),
  git: (taskId: string) => request<GitView>('GET', `/api/tasks/${encodeURIComponent(taskId)}/git`),
  diff: (taskId: string, path: string) => request<FileDiff>('GET', `/api/tasks/${encodeURIComponent(taskId)}/diff?path=${encodeURIComponent(path)}`),
  saveWorkflow: (file: string, graph: WorkflowGraphInput) => request<WorkflowDetail>('PUT', `/api/workflows/${encodeURIComponent(file)}`, graph),
  createTask: (input: NewTaskInput) => request<TaskSummary>('POST', '/api/tasks', input),
  message: (taskId: string, body: { text: string; mode: MessageMode; runId?: string; stepId?: string; files?: ChatFile[] }) =>
    request<{ ok: true }>('POST', `/api/tasks/${encodeURIComponent(taskId)}/messages`, body),
  /** Put one file in the task's worktree. `data` is the file's bytes as base64. */
  attach: (taskId: string, body: { name: string; data: string }) =>
    request<ChatFile>('POST', `/api/tasks/${encodeURIComponent(taskId)}/attachments`, body),
  retry: (taskId: string, body: { stepId?: string; note?: string }) =>
    request<{ ok: true }>('POST', `/api/tasks/${encodeURIComponent(taskId)}/retry`, body),
  interrupt: (taskId: string) => request<{ ok: true }>('POST', `/api/tasks/${encodeURIComponent(taskId)}/interrupt`),
  stop: (taskId: string) => request<{ ok: true }>('POST', `/api/tasks/${encodeURIComponent(taskId)}/stop`),
  decide: (runId: string, body: { choice: string; comment?: string }) =>
    request<{ ok: true }>('POST', `/api/runs/${encodeURIComponent(runId)}/decide`, body),
};

export const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Where the browser reads an attachment's bytes (a thumbnail, or a click to open it). */
export const fileUrl = (taskId: string, path: string) => `/api/tasks/${encodeURIComponent(taskId)}/attachment?path=${encodeURIComponent(path)}`;
export const cosFileUrl = (path: string) => `/api/cos/attachment?path=${encodeURIComponent(path)}`;
