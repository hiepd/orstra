import { useState, type ReactNode } from 'react';
import { api, errorMessage, type TaskDetail } from '../api';
import { awaitingTitle } from '../lib/describe';
import { agentOf, humanize, reasonText, taskLabel } from '../lib/format';
import { taskState } from '../lib/taskState';
import { StopIcon, StuckCircle, WaitCircle } from './Icons';
import { Modal, useToast } from './Overlay';
import { href } from '../lib/router';
import { ProgressList } from './ProgressList';
import { Markdown } from './Markdown';
import { briefOf } from '../lib/brief';

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
  start: 'Started. The agent picks it up next.',
  close: 'Closed',
  reopen: 'Reopened. The agent picks it up next.',
};
const isReject = (c: string) => /^reject/.test(c);
const isApprove = (c: string) => /^(approve|start|close)/.test(c);
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

/**
 * A tool call that waits for your OK. Allow runs it once; "Allow for this task" lets every later call
 * of that tool in this task pass without a question. Refuse sends your reason to the agent.
 */
export function PermissionCard({ task }: { task: TaskDetail }) {
  const toast = useToast();
  const p = task.permission;
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  if (!p) return null;
  const run = task.runs.find((r) => r.id === p.runId);
  const answer = async (allow: boolean, always = false) => {
    setBusy(true);
    try {
      await api.answerPermission(p.id, { allow, always, message: allow ? undefined : reason.trim() || undefined });
      toast(allow ? `Allowed ${p.tool}` : `Refused ${p.tool}`);
    } catch (err) {
      toast(errorMessage(err), { error: true });
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="lx-card lx-await" aria-label="Permission question">
      <div className="lx-card-h">
        <WaitCircle />
        <span style={{ color: 'var(--ink)', fontWeight: 500 }}>
          {run ? agentOf(run).name : 'The agent'} wants to use {p.tool}
        </span>
      </div>
      {p.summary && <p className="lx-awaittext lx-mono">{p.summary}</p>}
      <details>
        <summary className="lx-hint" style={{ cursor: 'pointer' }}>
          Full input
        </summary>
        <pre className="ox-pre">{p.input}</pre>
      </details>
      <input
        className="lx-input"
        aria-label="Reason to refuse (optional)"
        placeholder="If you refuse: what should it do instead? (optional)"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <div className="lx-card-f">
        <span className="lx-hint">The permission mode does not allow this tool, so Orstra asks you.</span>
        <div className="lx-push">
          <button className="lx-btn lx-dan" disabled={busy} onClick={() => void answer(false)}>
            Refuse
          </button>
          <button className="lx-btn" disabled={busy} onClick={() => void answer(true, true)}>
            Allow for this task
          </button>
          <button className="lx-btn lx-pri" disabled={busy} onClick={() => void answer(true)}>
            Allow once
          </button>
        </div>
      </div>
    </section>
  );
}

/** An agent run waiting on you. Answer it with the chat composer. */
export function AwaitingCard({ task, children }: { task: TaskDetail; children?: ReactNode }) {
  const a = task.awaiting;
  if (!a) return null;
  const title = awaitingTitle(taskState(task), a.reason);
  const brief = a.text ? briefOf(a.text) : null;
  return (
    <section className="lx-card lx-await" aria-label={title}>
      <div className="lx-card-h">
        {a.reason === 'paused' ? <StopIcon /> : <WaitCircle />}
        <span style={{ color: 'var(--ink)', fontWeight: 500 }}>{title}</span>
      </div>
      {brief && (
        <div className="lx-brief">
          <Markdown text={brief.lead} />
          {brief.parts.length > 0 && (
            <ul>
              {brief.parts.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {taskState(task) === 'paused' && !a.text && <p className="lx-awaittext">Send a message to pick the session up where it left off.</p>}
      {children}
    </section>
  );
}

/** Shown when a task needs you but there's no decision to make: retry or stop. */
export function StuckBanner({ task, onDone }: { task: TaskDetail; onDone?: () => void }) {
  const [modal, setModal] = useState<'retry' | 'stop' | null>(null);
  const fromEvents = [...task.events].reverse().find((e) => e.kind === 'system');
  const lastText = fromEvents && fromEvents.kind === 'system' ? fromEvents.text : task.lastSystem ?? null;
  const lastRun = [...task.runs].reverse().find((r) => r.stepId === task.currentStep) ?? task.runs[task.runs.length - 1];
  const lastFail = [...task.runs].reverse().find((r) => r.kind === 'gate' && r.outcome === 'fail' && r.output);
  const lastAgent = [...task.runs].reverse().find((r) => r.kind === 'agent');
  return (
    <section className="lx-card lx-stuck" aria-label="Needs you">
      <div className="lx-card-h">
        <StuckCircle />
        <span style={{ color: 'var(--red-fg)', fontWeight: 500 }}>{reasonText(task.inboxReason)}</span>
      </div>
      {lastText && <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.55 }}>{lastText}</p>}
      {lastFail?.output && (
        <div>
          <div className="lx-hint" style={{ marginBottom: 6 }}>
            What failed · {lastFail.stepTitle}
            {lastFail.attempt > 1 ? ` · attempt ${lastFail.attempt}` : ''}
          </div>
          <pre className="ox-pre">{lastFail.output.trim().split('\n').slice(-8).join('\n')}</pre>
        </div>
      )}
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
          {lastAgent?.sessionId && (
            <a className="lx-btn" href={href.chat(task.id, lastAgent.id)}>
              Ask {agentOf(lastAgent).name} why
            </a>
          )}
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

/** The step a reopened task goes back to: its first agent step. */
export const reopenStep = (task: TaskDetail) => task.steps.find((s) => s.kind === 'agent')?.id;

/**
 * Re-run a step (default: the current one) as a fresh session, with an optional note. With `reopen`,
 * it is how a done task takes more work: its first agent step runs again with what should change.
 */
export function RetryModal({ task, stepId, reopen, onClose, onDone }: { task: TaskDetail; stepId?: string; reopen?: boolean; onClose: () => void; onDone?: () => void }) {
  const toast = useToast();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const target = reopen ? stepId ?? reopenStep(task) : stepId;
  const stepTitle = task.steps.find((s) => s.id === (target ?? task.currentStep))?.title ?? task.currentStepTitle ?? 'this step';
  const submit = async () => {
    setBusy(true);
    try {
      await api.retry(task.id, { stepId: target, note: note.trim() || undefined });
      toast(reopen ? `Reopened. ${stepTitle} picks it up next.` : `Queued a fresh run of ${stepTitle}`);
      onClose();
      onDone?.();
    } catch (err) {
      toast(errorMessage(err), { error: true });
      setBusy(false);
    }
  };
  return (
    <Modal
      crumb={<span>{taskLabel(task)} › {reopen ? 'Reopen' : 'Re-run'}</span>}
      title={reopen ? 'Reopen this task' : `Re-run ${stepTitle}`}
      onClose={onClose}
      footer={
        <>
          <button className="lx-btn" onClick={onClose}>
            Cancel
          </button>
          <button className="lx-btn lx-pri" onClick={() => void submit()} disabled={busy || (reopen && !note.trim())}>
            {busy && <span className="lx-spin" aria-hidden="true" />}
            {reopen ? 'Reopen' : 'Re-run step'}
          </button>
        </>
      }
    >
      <p>
        {reopen
          ? `${stepTitle} starts a fresh session from the task’s progress and your note. The steps after it run again, so you review it once more.`
          : 'Starts a fresh session from the task’s progress and your note. The steps after it run again.'}
      </p>
      <textarea
        className="lx-field"
        aria-label={reopen ? 'What should change' : 'Note for the new run'}
        placeholder={reopen ? 'What should change?' : 'What should it do differently? (optional)'}
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
