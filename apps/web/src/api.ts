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

export interface SessionView extends RunView {
  kind: 'agent' | 'gate';
  task: TaskSummary;
  now: string | null;
}

export interface StepView {
  id: string;
  title: string;
  kind: StepKind;
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
    | { kind: 'you'; mode: MessageMode | 'decision' | 'interrupt' | 'steer'; text: string; choice?: string; step?: string | null }
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
  runs: RunView[];
  human: HumanDecision | null;
  awaiting?: Awaiting | null;
  workingRunId?: string | null;
  events: TaskEvent[];
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
  sessions: () => request<SessionView[]>('GET', '/api/sessions'),
  tasks: () => request<TaskSummary[]>('GET', '/api/tasks'),
  task: (id: string) => request<TaskDetail>('GET', `/api/tasks/${encodeURIComponent(id)}`),
  inbox: () => request<TaskDetail[]>('GET', '/api/inbox'),
  workflows: () => request<WorkflowInfo[]>('GET', '/api/workflows'),
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
