import { useState } from 'react';
import type { RunView, StepView, TaskDetail, TaskEvent } from '../api';
import { agentOf, humanize, taskLabel } from '../lib/format';
import { ago, duration } from '../lib/time';
import { AskCopy, NoteInput } from './Composer';
import { EventFeed } from './EventFeed';
import { ChevronRight, TerminalIcon } from './Icons';
import { Peek } from './Overlay';
import { ProgressList } from './ProgressList';
import { AgentAvatar, RunStatusIcon } from './Status';

/** Side panel for a workflow step: every run of it, newest first. */
export function StepPeek({
  task,
  step,
  onClose,
  onRerun,
  onOpenCC,
}: {
  task: TaskDetail;
  step: StepView;
  onClose: () => void;
  onRerun: () => void;
  onOpenCC: (run: RunView) => void;
}) {
  const runs = task.runs.filter((r) => r.stepId === step.id).reverse();
  const canRerun = step.kind !== 'human' || task.status !== 'done';
  return (
    <Peek
      label="Step details"
      onClose={onClose}
      header={
        <>
          <span className="lx-mono">{taskLabel(task)}</span>
          <span>›</span>
          <span className="lx-cur">{step.title}</span>
        </>
      }
      footer={
        canRerun ? (
          <div className="lx-pef">
            <button className="lx-btn" onClick={onRerun}>
              Re-run this step…
            </button>
          </div>
        ) : undefined
      }
    >
      <div>
        <h2>{step.title}</h2>
        <div className="lx-meta" style={{ marginTop: 6 }}>
          {humanize(step.kind)} step · {runs.length} {runs.length === 1 ? 'run' : 'runs'}
          {Object.keys(step.on).length > 0 && (
            <span>
              · {Object.entries(step.on)
                .map(([outcome, to]) => `${outcome} → ${to === 'end' ? 'finish' : to}`)
                .join(', ')}
            </span>
          )}
        </div>
      </div>
      {runs.length === 0 && <StepNotes task={task} step={step} />}
      {runs.map((r, i) => (
        <RunCard key={r.id} task={task} run={r} defaultOpen={i === 0} onOpenCC={() => onOpenCC(r)} />
      ))}
    </Peek>
  );
}

function RunCard({ task, run, defaultOpen, onOpenCC }: { task: TaskDetail; run: RunView; defaultOpen: boolean; onOpenCC: () => void }) {
  const [open, setOpen] = useState(defaultOpen && run.kind !== 'gate');
  const mine = task.events.filter((e) => e.runId === run.id);
  const isAsk = (e: TaskEvent) => e.kind === 'aside' || (e.kind === 'you' && e.mode === 'ask');
  const events = mine.filter((e) => e.kind !== 'progress' && e.kind !== 'output' && !isAsk(e));
  const asks = mine.filter(isAsk);
  const live = run.status === 'running' || run.status === 'queued';
  const showAgent = run.kind === 'agent' || run.kind === 'gate';
  const outcomeClass = run.status === 'failed' ? 'lx-bad' : run.status === 'done' ? 'lx-ok' : '';
  return (
    <div className="lx-runcard">
      <div className="lx-runhead">
        <RunStatusIcon status={run.status} outcome={run.outcome} />
        <b>Attempt {run.attempt}</b>
        {run.outcome ? <span className={`lx-pill ${outcomeClass}`}>{run.outcome.replace(/_/g, ' ')}</span> : <span className="lx-pill">{run.status}</span>}
        {showAgent && <AgentAvatar run={run} />}
        <span className="lx-muted">
          {run.startedAt ? duration(run.startedAt, run.endedAt ?? Date.now()) : 'not started'}
          {run.endedAt ? ` · ${ago(run.endedAt)}` : ''}
        </span>
      </div>
      {run.progress && <ProgressList progress={run.progress} />}
      {run.kind === 'gate' && run.output && <pre className="lx-out">{run.output}</pre>}
      {run.kind === 'agent' && run.sessionId && (
        <div>
          <button className="lx-btn" onClick={onOpenCC}>
            <TerminalIcon size={13} />
            {live ? 'Open in Claude Code' : `Open a copy in ${agentOf(run).name}`}
          </button>
        </div>
      )}
      {run.kind === 'agent' && run.sessionId && (
        <div className="lx-qa">
          <span className="lx-hint">Ask a copy · a forked session answers; the work isn’t touched</span>
          {asks.map((e) =>
            e.kind === 'aside' ? (
              <div key={e.id} className="lx-aside">
                {e.text}
              </div>
            ) : e.kind === 'you' ? (
              <div key={e.id} className="lx-you">
                {e.text}
              </div>
            ) : null,
          )}
          <AskCopy taskId={task.id} runId={run.id} who={agentOf(run).name} />
        </div>
      )}
      {events.length > 0 && (
        <>
          <button className="lx-tool" style={{ cursor: 'pointer' }} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
            <ChevronRight open={open} />
            Session activity <span className="lx-hint">{events.length}</span>
          </button>
          {open && <EventFeed events={events} runs={task.runs} steps={task.steps} limit={40} compact />}
        </>
      )}
    </div>
  );
}

/** A step that hasn't run: notes you've left for it, and a box to add one. */
function StepNotes({ task, step }: { task: TaskDetail; step: StepView }) {
  const notes = task.events.filter((e) => e.kind === 'note' && e.step === step.id);
  return (
    <div className="lx-qa">
      <p className="lx-hint" style={{ margin: 0 }}>
        This step hasn’t run yet.
      </p>
      <p className="lx-sec" style={{ margin: '6px 0 0' }}>
        Add a note for this step
      </p>
      <span className="lx-hint">The agent reads it when the step starts.</span>
      {notes.map((n) =>
        n.kind === 'note' ? (
          <div key={n.id} className="lx-note">
            {n.text}
          </div>
        ) : null,
      )}
      <NoteInput taskId={task.id} stepId={step.id} />
    </div>
  );
}
