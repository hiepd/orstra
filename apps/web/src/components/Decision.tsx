import { useState, type ReactNode } from 'react';
import { api, errorMessage, type TaskDetail } from '../api';
import { humanize, reasonText, taskLabel } from '../lib/format';
import { StopIcon, StuckCircle, WaitCircle } from './Icons';
import { Modal, useToast } from './Overlay';
import { ProgressList } from './ProgressList';

const CHOICE_LABEL: Record<string, string> = {
  approved: 'Approve',
  approve: 'Approve',
  changes_requested: 'Request changes',
  rejected: 'Reject…',
  reject: 'Reject…',
};
const DONE_TOAST: Record<string, string> = {
  approved: 'Approved',
  changes_requested: 'Changes requested. The agent picks it up next.',
  rejected: 'Rejected',
};
const isReject = (c: string) => /^reject/.test(c);
const isApprove = (c: string) => /^approve/.test(c);
const choiceLabel = (c: string) => CHOICE_LABEL[c] ?? humanize(c);

/** The human step's decision: the question, the artifact's progress, one button per choice. */
export function DecisionCard({ task, onDone }: { task: TaskDetail; onDone?: () => void }) {
  const human = task.human;
  const toast = useToast();
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmReject, setConfirmReject] = useState<string | null>(null);
  if (!human) return null;

  const run = task.runs.find((r) => r.id === human.runId);
  const step = task.steps.find((s) => s.id === run?.stepId);
  const consequence = (c: string) => {
    const to = step?.on[c];
    if (!to) return null;
    return to === 'end' ? 'finishes the task' : `goes to ${to}`;
  };

  const decide = async (choice: string) => {
    setBusy(choice);
    try {
      await api.decide(human.runId, { choice, comment: comment.trim() || undefined });
      toast(DONE_TOAST[choice] ?? `Decided: ${humanize(choice)}`);
      setComment('');
      setConfirmReject(null);
      onDone?.();
    } catch (err) {
      toast(errorMessage(err), { error: true });
    } finally {
      setBusy(null);
    }
  };

  // Reject on the left, then the rest, approve last (primary).
  const ordered = [...human.choices].sort((a, b) => rank(a) - rank(b));
  const rejects = ordered.filter(isReject);
  const others = ordered.filter((c) => !isReject(c));

  return (
    <section className="lx-card" aria-label="Decision">
      <div className="lx-card-h">
        <WaitCircle />
        <span>Waiting for your decision{run ? ` · ${run.stepTitle}` : ''}</span>
      </div>
      <p className="lx-q">{human.question}</p>
      {human.artifact && (
        <div>
          <div className="lx-hint" style={{ marginBottom: 6 }}>
            From {human.artifact.step}
          </div>
          <ProgressList progress={human.artifact.progress} />
        </div>
      )}
      <textarea
        className="lx-field"
        aria-label="Comment for the next step (optional)"
        placeholder="Add a comment for the next step (optional)"
        value={comment}
        onChange={(e) => setComment(e.target.value)}
      />
      <div className="lx-card-f">
        {rejects.map((c) => (
          <button key={c} className="lx-btn lx-dan" onClick={() => setConfirmReject(c)} disabled={busy !== null}>
            {choiceLabel(c)}
          </button>
        ))}
        <div className="lx-push">
          {others.map((c) => (
            <button key={c} className={`lx-btn${isApprove(c) ? ' lx-pri' : ''}`} onClick={() => void decide(c)} disabled={busy !== null} title={consequence(c) ?? undefined}>
              {busy === c && <span className="lx-spin" aria-hidden="true" />}
              {choiceLabel(c)}
            </button>
          ))}
        </div>
      </div>
      {step && (
        <div className="lx-hint">
          {human.choices
            .map((c) => {
              const what = consequence(c);
              return what ? `${choiceLabel(c).replace('…', '')} ${what}` : null;
            })
            .filter(Boolean)
            .join(' · ')}
        </div>
      )}
      {confirmReject && (
        <Modal
          crumb={<span>{taskLabel(task)} › Reject</span>}
          title="Reject this?"
          onClose={() => setConfirmReject(null)}
          footer={
            <>
              <button className="lx-btn" onClick={() => setConfirmReject(null)}>
                Cancel
              </button>
              <button className="lx-btn lx-danfill" onClick={() => void decide(confirmReject)} disabled={busy !== null}>
                {busy && <span className="lx-spin" aria-hidden="true" />}
                Reject
              </button>
            </>
          }
        >
          <p>
            {consequence(confirmReject) ? `Rejecting ${consequence(confirmReject)}.` : 'The task follows the workflow’s reject path.'} You can add a reason; it’s kept with the task.
          </p>
          <textarea className="lx-field" aria-label="Reason" placeholder="Why? (optional)" value={comment} onChange={(e) => setComment(e.target.value)} autoFocus />
        </Modal>
      )}
    </section>
  );
}

function rank(c: string) {
  if (isReject(c)) return 0;
  if (isApprove(c)) return 2;
  return 1;
}

const AWAITING_TITLE: Record<string, string> = {
  question: 'Claude Code is asking',
  reply: 'Claude Code replied',
  paused: 'You stopped Claude Code',
  restarted: 'Orstra restarted mid-run',
};

/** An agent run waiting on you. Answer it with the chat composer. */
export function AwaitingCard({ task, children }: { task: TaskDetail; children?: ReactNode }) {
  const a = task.awaiting;
  if (!a) return null;
  const run = task.runs.find((r) => r.id === a.runId);
  const title = AWAITING_TITLE[a.reason ?? ''] ?? 'Claude Code is waiting for you';
  return (
    <section className="lx-card lx-await" aria-label={title}>
      <div className="lx-card-h">
        {a.reason === 'paused' ? <StopIcon /> : <WaitCircle />}
        <span style={{ color: '#1B1B1F', fontWeight: 500 }}>{title}</span>
        {run && (
          <span>
            · {run.stepTitle}
            {run.attempt > 1 ? ` · attempt ${run.attempt}` : ''}
          </span>
        )}
      </div>
      {a.text && <p className="lx-awaittext">{a.text}</p>}
      {a.reason === 'restarted' && !a.text && <p className="lx-awaittext">Send a message to pick the session up where it left off.</p>}
      {children}
    </section>
  );
}

/** Shown when a task needs you but there's no decision to make: retry or stop. */
export function StuckBanner({ task, onDone }: { task: TaskDetail; onDone?: () => void }) {
  const [modal, setModal] = useState<'retry' | 'stop' | null>(null);
  const lastSystem = [...task.events].reverse().find((e) => e.kind === 'system');
  const lastRun = [...task.runs].reverse().find((r) => r.stepId === task.currentStep) ?? task.runs[task.runs.length - 1];
  return (
    <section className="lx-card lx-stuck" aria-label="Needs you">
      <div className="lx-card-h">
        <StuckCircle />
        <span style={{ color: '#C4292F', fontWeight: 500 }}>{reasonText(task.inboxReason)}</span>
      </div>
      {lastSystem && lastSystem.kind === 'system' && <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.55 }}>{lastSystem.text}</p>}
      {lastRun?.progress && (
        <div>
          <div className="lx-hint" style={{ marginBottom: 6 }}>
            Last run · {lastRun.stepTitle}
            {lastRun.attempt > 1 ? ` · attempt ${lastRun.attempt}` : ''}
          </div>
          <ProgressList progress={lastRun.progress} />
        </div>
      )}
      <div className="lx-card-f">
        <span className="lx-hint">{task.currentStepTitle ? `Stuck at ${task.currentStepTitle}` : ''}</span>
        <div className="lx-push">
          <button className="lx-btn lx-dan" onClick={() => setModal('stop')}>
            Stop
          </button>
          <button className="lx-btn lx-pri" onClick={() => setModal('retry')} disabled={!task.currentStep}>
            Retry…
          </button>
        </div>
      </div>
      {modal === 'retry' && <RetryModal task={task} onClose={() => setModal(null)} onDone={onDone} />}
      {modal === 'stop' && <StopModal task={task} onClose={() => setModal(null)} onDone={onDone} />}
    </section>
  );
}

/** Re-run a step (default: the current one) as a fresh session, with an optional note. */
export function RetryModal({ task, stepId, onClose, onDone }: { task: TaskDetail; stepId?: string; onClose: () => void; onDone?: () => void }) {
  const toast = useToast();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const stepTitle = task.steps.find((s) => s.id === (stepId ?? task.currentStep))?.title ?? task.currentStepTitle ?? 'this step';
  const submit = async () => {
    setBusy(true);
    try {
      await api.retry(task.id, { stepId, note: note.trim() || undefined });
      toast(`Queued a fresh run of ${stepTitle}`);
      onClose();
      onDone?.();
    } catch (err) {
      toast(errorMessage(err), { error: true });
      setBusy(false);
    }
  };
  return (
    <Modal
      crumb={<span>{taskLabel(task)} › Re-run</span>}
      title={`Re-run ${stepTitle}`}
      onClose={onClose}
      footer={
        <>
          <button className="lx-btn" onClick={onClose}>
            Cancel
          </button>
          <button className="lx-btn lx-pri" onClick={() => void submit()} disabled={busy}>
            {busy && <span className="lx-spin" aria-hidden="true" />}
            Re-run step
          </button>
        </>
      }
    >
      <p>Starts a fresh session from the task’s progress and your note. The steps after it run again.</p>
      <textarea
        className="lx-field"
        aria-label="Note for the new run"
        placeholder="What should it do differently? (optional)"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        autoFocus
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit();
        }}
      />
    </Modal>
  );
}

export function StopModal({ task, onClose, onDone }: { task: TaskDetail; onClose: () => void; onDone?: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      await api.stop(task.id);
      toast(`${taskLabel(task)} stopped`);
      onClose();
      onDone?.();
    } catch (err) {
      toast(errorMessage(err), { error: true });
      setBusy(false);
    }
  };
  return (
    <Modal
      crumb={<span>{taskLabel(task)} › Stop</span>}
      title="Stop this task?"
      onClose={onClose}
      footer={
        <>
          <button className="lx-btn" onClick={onClose}>
            Cancel
          </button>
          <button className="lx-btn lx-danfill" onClick={() => void submit()} disabled={busy}>
            {busy && <span className="lx-spin" aria-hidden="true" />}
            Stop task
          </button>
        </>
      }
    >
      <p>Any running session stops now and nothing else runs for this task. The worktree and every session are kept.</p>
    </Modal>
  );
}
