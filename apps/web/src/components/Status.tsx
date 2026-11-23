import type { RunStatus, RunView, TaskSummary } from '../api';
import { agentOf } from '../lib/format';
import { DoneCircle, FailCircle, LiveCircle, StoppedCircle, StuckCircle, TodoCircle, WaitCircle } from './Icons';

export function RunStatusIcon({ status, outcome }: { status: RunStatus | 'todo'; outcome?: string | null }) {
  switch (status) {
    case 'done':
      return <DoneCircle label={outcome ? `Done · ${outcome}` : 'Done'} />;
    case 'failed':
      return <FailCircle label={outcome ? `Failed · ${outcome}` : 'Failed'} />;
    case 'running':
      return <LiveCircle />;
    case 'waiting':
      return <WaitCircle />;
    case 'queued':
      return <TodoCircle label="Queued" dashed />;
    case 'stopped':
      return <StoppedCircle />;
    default:
      return <TodoCircle />;
  }
}

export function TaskStatusIcon({ task }: { task: Pick<TaskSummary, 'status' | 'inboxReason'> }) {
  switch (task.status) {
    case 'done':
      return <DoneCircle />;
    case 'running':
      return <LiveCircle label="Running" />;
    case 'stopped':
      return <StoppedCircle />;
    case 'needs_you':
      return task.inboxReason === 'decision' ? <WaitCircle label="Needs a decision" /> : <StuckCircle />;
  }
}

export function AgentAvatar({ run, large }: { run: Pick<RunView, 'kind' | 'agent'>; large?: boolean }) {
  const a = agentOf(run);
  return (
    <span className={`lx-av${large ? ' lx-av-lg' : ''}`} style={{ background: a.color }} title={a.name}>
      {a.av}
    </span>
  );
}

export const YouAvatar = () => (
  <span className="lx-av" style={{ background: 'var(--accent)' }} title="You">
    Y
  </span>
);
