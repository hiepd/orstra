// Types and calls for the Orstra daemon API (proxied at /api in dev, same origin in prod).

export type Progress = { did: string; decided?: string; left?: string; avoid?: string };

export type TaskStatus = 'running' | 'needs_you' | 'done' | 'stopped';
export type RunStatus = 'queued' | 'running' | 'waiting' | 'done' | 'failed' | 'stopped';
export type StepKind = 'agent' | 'gate' | 'human' | 'switch' | 'action' | 'workflow';
export type AgentName = 'claude-code' | 'codex';
export type MessageMode = 'chat' | 'note' | 'ask';

export interface TaskSummary {
  id: string;
  ref: string | null;
  title: string;
  workflow: string;
  status: TaskStatus;
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
    | { kind: 'you'; mode: MessageMode | 'decision' | 'interrupt' | 'steer'; text: string; choice?: string; step?: string | null; via?: 'cos' }
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
  action: string | null;
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
  steps: WorkflowStep[];
}

export interface Settings {
  home: string;
  database: string;
  worktrees: string;
  workflowDirs: string[];
  port: number;
  slots: number;
  agents: { id: AgentName; name: string; command: string; path: string | null }[];
}

/** One entry in the chief of staff conversation. */
export type CosEvent = { id: number; ts: number } & (
  | { kind: 'you'; text: string }
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

async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
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
  cos: () => request<CosView>('GET', '/api/cos'),
  cosSay: (text: string) => request<{ ok: true }>('POST', '/api/cos/messages', { text }),
  cosInterrupt: () => request<{ ok: true }>('POST', '/api/cos/interrupt'),
  cosPlan: (id: string, answer: 'approve' | 'decline') => request<{ ok: true }>('POST', `/api/cos/plans/${encodeURIComponent(id)}/${answer}`),
  cosUnwatch: (id: string) => request<{ ok: true }>('POST', `/api/cos/watches/${encodeURIComponent(id)}/remove`),
  cosPermission: (key: CosPermission, value: boolean) => request<{ ok: true }>('POST', '/api/cos/permissions', { key, value }),
  git: (taskId: string) => request<GitView>('GET', `/api/tasks/${encodeURIComponent(taskId)}/git`),
  diff: (taskId: string, path: string) => request<FileDiff>('GET', `/api/tasks/${encodeURIComponent(taskId)}/diff?path=${encodeURIComponent(path)}`),
  createTask: (input: NewTaskInput) => request<TaskSummary>('POST', '/api/tasks', input),
  message: (taskId: string, body: { text: string; mode: MessageMode; runId?: string; stepId?: string }) =>
    request<{ ok: true }>('POST', `/api/tasks/${encodeURIComponent(taskId)}/messages`, body),
  retry: (taskId: string, body: { stepId?: string; note?: string }) =>
    request<{ ok: true }>('POST', `/api/tasks/${encodeURIComponent(taskId)}/retry`, body),
  interrupt: (taskId: string) => request<{ ok: true }>('POST', `/api/tasks/${encodeURIComponent(taskId)}/interrupt`),
  stop: (taskId: string) => request<{ ok: true }>('POST', `/api/tasks/${encodeURIComponent(taskId)}/stop`),
  decide: (runId: string, body: { choice: string; comment?: string }) =>
    request<{ ok: true }>('POST', `/api/runs/${encodeURIComponent(runId)}/decide`, body),
};

export const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
