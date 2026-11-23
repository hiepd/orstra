import { useCallback } from 'react';
import { api, type RunView, type TaskSummary } from '../api';
import { agentOf, taskLabel } from '../lib/format';
import { useLiveResource } from '../lib/live';
import { href } from '../lib/router';
import { duration } from '../lib/time';
import { ChatComposer } from './Composer';
import { EventFeed } from './EventFeed';
import { TerminalIcon } from './Icons';
import { Peek } from './Overlay';
import { ProgressList } from './ProgressList';
import { AgentAvatar } from './Status';

const STATE_TEXT: Record<RunView['status'], string> = {
  running: 'running',
  queued: 'queued',
  waiting: 'waiting for you',
  done: 'ended',
  failed: 'failed',
  stopped: 'stopped',
};

/** Side panel for one session (run) from the Sessions list. */
export function RunPeek({ run, task, onClose, onOpenCC }: { run: RunView; task: TaskSummary; onClose: () => void; onOpenCC: () => void }) {
  const detail = useLiveResource(`task:${task.id}`, useCallback(() => api.task(task.id), [task.id]), (id) => id === task.id);
  const a = agentOf(run);
  const live = run.status === 'running' || run.status === 'queued' || run.status === 'waiting';
  const events = (detail.data?.events ?? []).filter((e) => e.runId === run.id && e.kind !== 'progress');
  const time = run.status === 'queued' ? 'waiting for a slot' : duration(run.startedAt, run.endedAt ?? Date.now());
  const canCC = run.kind === 'agent' && !!run.sessionId;

  return (
    <Peek
      label="Session"
      onClose={onClose}
      header={
        <>
          <span className="lx-mono">{taskLabel(task)}</span>
          <span>›</span>
          <span className="lx-cur">
            {run.stepTitle}
            {run.attempt > 1 ? ` · attempt ${run.attempt}` : ''}
          </span>
        </>
      }
      footer={
        run.kind === 'agent' && (run.sessionId || live) ? (
          <div style={{ padding: '0 16px 14px', flex: 'none' }}>
            <ChatComposer
              key={run.id}
              taskId={task.id}
              runId={run.id}
              working={!!run.live && run.status === 'running'}
              awaiting={run.status === 'waiting'}
              autoFocus={run.status === 'waiting'}
              who={a.name}
            />
          </div>
        ) : undefined
      }
    >
      <div>
        <h2>{task.title}</h2>
        <div className="lx-meta" style={{ marginTop: 6 }}>
          <AgentAvatar run={run} />
          {a.name} · {STATE_TEXT[run.status]}
          {run.outcome ? ` (${run.outcome})` : ''} · {time}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {canCC && (
          <button className="lx-btn lx-pri" onClick={onOpenCC}>
            <TerminalIcon size={13} />
            {live ? 'Open in Claude Code' : 'Open a copy in Claude Code'}
          </button>
        )}
        <a className="lx-btn" href={href.task(task.id)}>
          Open the task
        </a>
      </div>
      {run.progress && (
        <>
          <p className="lx-sec">What it did</p>
          <div className="lx-note">
            <ProgressList progress={run.progress} />
          </div>
        </>
      )}
      {run.kind === 'gate' && run.output && !live && (
        <>
          <p className="lx-sec">Output</p>
          <pre className="lx-out">{run.output}</pre>
        </>
      )}
      {!(run.kind === 'gate' && run.output && !live) && (
        <>
          <p className="lx-sec">{run.status === 'queued' ? 'Not started yet' : live ? 'Latest' : 'Last actions'}</p>
          {detail.loading && !detail.data ? (
            <div className="lx-hint">Loading…</div>
          ) : (
            <EventFeed
              events={events}
              runs={detail.data?.runs ?? [run]}
              steps={detail.data?.steps ?? []}
              limit={40}
              compact
              empty={<div className="lx-hint">{run.status === 'queued' ? 'Starts when a slot frees up.' : 'Nothing recorded yet.'}</div>}
            />
          )}
        </>
      )}
    </Peek>
  );
}
