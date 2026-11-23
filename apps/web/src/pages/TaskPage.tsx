import { useCallback, useMemo, useState } from 'react';
import { api, type RunView, type StepView, type TaskDetail } from '../api';
import { ClaudeCodeModal } from '../components/ClaudeCodeModal';
import { ChatComposer } from '../components/Composer';
import { AwaitingCard, DecisionCard, RetryModal, StopModal, StuckBanner } from '../components/Decision';
import { EventFeed, useAutoScroll } from '../components/EventFeed';
import { CopyIcon, LinkIcon, MoreIcon, TerminalIcon } from '../components/Icons';
import { Menu, useToast } from '../components/Overlay';
import { AgentAvatar, RunStatusIcon, TaskStatusIcon } from '../components/Status';
import { StepPeek } from '../components/StepPeek';
import { agentOf, humanize, reasonText, TASK_STATUS_LABEL, taskLabel } from '../lib/format';
import { useLiveResource, useNow } from '../lib/live';
import { href } from '../lib/router';
import { ago, duration } from '../lib/time';

type Modal = { kind: 'retry'; stepId?: string } | { kind: 'stop' } | { kind: 'cc'; run: RunView } | null;

export function TaskPage({ id }: { id: string }) {
  const res = useLiveResource(`task:${id}`, useCallback(() => api.task(id), [id]), (taskId) => taskId === id);
  const task = res.data;

  if (!task) {
    return (
      <>
        <div className="lx-bar">
          <div className="lx-crumb">
            <a href={href.tasks}>Tasks</a>
            <span>›</span>
            <b>{id.slice(0, 8)}</b>
          </div>
        </div>
        {res.error ? (
          <div className="lx-empty">
            <b>{res.error === 'No such task' ? 'This task doesn’t exist' : 'Couldn’t load the task'}</b>
            <span>{res.error}</span>
            <a className="lx-btn" href={href.tasks}>
              Back to tasks
            </a>
          </div>
        ) : (
          <div className="lx-loading">
            <span className="lx-spin" /> Loading…
          </div>
        )}
      </>
    );
  }
  return <TaskView task={task} />;
}

function latestRunByStep(runs: RunView[]): Map<string, RunView> {
  const m = new Map<string, RunView>();
  for (const r of runs) m.set(r.stepId, r); // runs come oldest first
  return m;
}

function TaskView({ task }: { task: TaskDetail }) {
  const toast = useToast();
  useNow(15_000);
  const [peekStep, setPeekStep] = useState<string | null>(null);
  const [modal, setModal] = useState<Modal>(null);
  const [menu, setMenu] = useState(false);
  const [allRuns, setAllRuns] = useState(false);
  const closeMenu = useCallback(() => setMenu(false), []);
  const closePeek = useCallback(() => setPeekStep(null), []);

  const latest = useMemo(() => latestRunByStep(task.runs), [task.runs]);
  const byId = (rid?: string | null) => (rid ? task.runs.find((r) => r.id === rid) : undefined);
  const focusRun =
    byId(task.workingRunId) ?? byId(task.awaiting?.runId) ?? (task.currentStep ? latest.get(task.currentStep) : undefined) ?? task.runs[task.runs.length - 1];
  const agentRun = [...task.runs].reverse().find((r) => r.kind === 'agent');
  const ccRun = [...task.runs].reverse().find((r) => r.kind === 'agent' && r.sessionId);
  const stepsDone = task.steps.filter((s) => latest.get(s.id)?.status === 'done').length;
  const active = task.status === 'running' || task.status === 'needs_you';

  const feed = useMemo(
    () =>
      allRuns
        ? task.events
        : task.events.filter((e) => e.runId === null || e.runId === focusRun?.id || ['you', 'note', 'aside', 'system', 'progress'].includes(e.kind)),
    [task.events, allRuns, focusRun?.id],
  );
  const scroll = useAutoScroll<HTMLElement>(feed.length);

  const copyText = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast(`${what} copied`);
    } catch {
      toast('Couldn’t copy to the clipboard', { error: true });
    }
  };

  const peek = peekStep ? task.steps.find((s) => s.id === peekStep) : undefined;

  return (
    <>
      <div className="lx-bar">
        <div className="lx-crumb">
          <a href={href.tasks}>Tasks</a>
          <span>›</span>
          <b>{taskLabel(task)}</b>
        </div>
        <div className="lx-acts">
          {ccRun && (
            <button className="lx-btn" onClick={() => setModal({ kind: 'cc', run: ccRun })}>
              <TerminalIcon size={13} strokeWidth={2.2} />
              Open in Claude Code
            </button>
          )}
          <button className="lx-ib" aria-label="Copy link" title="Copy link" onClick={() => void copyText(window.location.href, 'Link')}>
            <LinkIcon />
          </button>
          <button className="lx-ib" aria-label="More actions" aria-expanded={menu} onClick={() => setMenu((m) => !m)}>
            <MoreIcon />
          </button>
          {menu && (
            <Menu onClose={closeMenu} style={{ right: 0, top: 34 }} label="Task actions">
              <button
                role="menuitem"
                disabled={!task.currentStep}
                onClick={() => {
                  setMenu(false);
                  setModal({ kind: 'retry' });
                }}
              >
                Re-run the current step…
              </button>
              {task.worktree && (
                <button
                  role="menuitem"
                  onClick={() => {
                    setMenu(false);
                    void copyText(task.worktree ?? '', 'Worktree path');
                  }}
                >
                  Copy worktree path
                </button>
              )}
              <hr />
              <button
                role="menuitem"
                className="lx-red"
                disabled={!active}
                style={active ? undefined : { opacity: 0.45 }}
                onClick={() => {
                  setMenu(false);
                  setModal({ kind: 'stop' });
                }}
              >
                Stop task…
              </button>
            </Menu>
          )}
        </div>
      </div>

      <div className="lx-split">
        <main className="lx-main" ref={scroll.ref} onScroll={scroll.onScroll}>
          <div className="lx-doc">
            <h1 className="lx-title">{task.title}</h1>
            {task.description && <p className="lx-desc">{task.description}</p>}

            {task.human && <DecisionCard task={task} />}
            {!task.human && task.awaiting && <AwaitingCard task={task} />}
            {!task.human && !task.awaiting && task.status === 'needs_you' && <StuckBanner task={task} />}

            <div className="lx-shead">
              Steps
              {task.steps.length > 0 && (
                <>
                  <span className="lx-prog" aria-hidden="true">
                    <i style={{ width: `${(stepsDone / task.steps.length) * 100}%` }} />
                  </span>
                  <span>
                    {stepsDone} / {task.steps.length}
                  </span>
                </>
              )}
            </div>
            <div className="lx-rows">
              {task.steps.length === 0 && <div className="lx-hint" style={{ padding: '10px 8px' }}>Couldn’t read this task’s workflow.</div>}
              {task.steps.map((s) => (
                <StepRow key={s.id} step={s} task={task} latest={latest.get(s.id)} selected={peekStep === s.id} onOpen={() => setPeekStep(s.id)} />
              ))}
            </div>

            <div className="lx-shead" style={{ marginTop: 32 }}>
              Activity
              {focusRun && !allRuns && (
                <span>
                  {focusRun.stepTitle}
                  {focusRun.attempt > 1 ? ` · attempt ${focusRun.attempt}` : ''}
                </span>
              )}
              {task.runs.length > 1 && (
                <button className="lx-more lx-sright" onClick={() => setAllRuns((a) => !a)}>
                  {allRuns ? 'Show the latest run' : 'Show all runs'}
                </button>
              )}
            </div>
            <EventFeed events={feed} runs={task.runs} steps={task.steps} empty={<div className="lx-hint">Nothing yet.</div>} />

            <div className="lx-compose">
              {active || ccRun ? (
                <ChatComposer
                  key={task.awaiting?.runId ?? 'chat'}
                  taskId={task.id}
                  working={!!task.workingRunId}
                  awaiting={!!task.awaiting}
                  autoFocus={!!task.awaiting}
                  who={agentRun ? agentOf(agentRun).name : 'Claude Code'}
                />
              ) : (
                <div className="lx-hint" style={{ textAlign: 'center' }}>
                  This task is {task.status === 'done' ? 'done' : 'stopped'}. Re-run a step to pick it up again.
                </div>
              )}
            </div>
          </div>
        </main>

        <Properties task={task} focusRun={focusRun} agentRun={agentRun} ccRun={ccRun} onCopy={copyText} onOpenCC={(run) => setModal({ kind: 'cc', run })} />
      </div>

      {peek && (
        <StepPeek
          task={task}
          step={peek}
          onClose={closePeek}
          onRerun={() => setModal({ kind: 'retry', stepId: peek.id })}
          onOpenCC={(run) => setModal({ kind: 'cc', run })}
        />
      )}
      {modal?.kind === 'retry' && <RetryModal task={task} stepId={modal.stepId} onClose={() => setModal(null)} onDone={closePeek} />}
      {modal?.kind === 'stop' && <StopModal task={task} onClose={() => setModal(null)} />}
      {modal?.kind === 'cc' && <ClaudeCodeModal run={modal.run} crumb={taskLabel(task)} onClose={() => setModal(null)} />}
    </>
  );
}

const KIND_SUMMARY: Record<StepView['kind'], string> = {
  agent: 'Agent step',
  gate: 'Runs checks',
  human: 'Your decision',
  switch: 'Picks a branch',
  action: 'Action',
  workflow: 'Runs another workflow',
};

function StepRow({ step, task, latest, selected, onOpen }: { step: StepView; task: TaskDetail; latest?: RunView; selected: boolean; onOpen: () => void }) {
  const attempts = task.runs.filter((r) => r.stepId === step.id).length;
  let summary = KIND_SUMMARY[step.kind];
  if (!latest) {
    const note = [...task.events].reverse().find((e) => e.kind === 'note' && e.step === step.id);
    if (note && note.kind === 'note') summary = `Your note: ${note.text}`;
  }
  if (latest) {
    if (latest.status === 'running') summary = step.kind === 'gate' ? 'Running checks…' : 'Working…';
    else if (latest.status === 'queued') summary = 'Queued';
    else if (latest.status === 'waiting') summary = latest.kind === 'human' ? 'Waiting for your decision' : 'Waiting for you';
    else if (latest.progress?.did) summary = latest.progress.did;
    else if (latest.outcome) summary = humanize(latest.outcome);
  }
  const meta = [
    attempts > 1 ? `${attempts} runs` : null,
    latest?.startedAt && latest.kind !== 'human' ? duration(latest.startedAt, latest.endedAt ?? Date.now()) : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const showAv = latest && (latest.kind === 'agent' || latest.kind === 'gate');
  return (
    <button className={`lx-row${selected ? ' lx-sel' : ''}`} onClick={onOpen}>
      <RunStatusIcon status={latest?.status ?? 'todo'} outcome={latest?.outcome} />
      <b>{step.title}</b>
      <span className="lx-rs">{summary}</span>
      {showAv && <AgentAvatar run={latest} />}
      {!latest && <span className="lx-kind">{step.kind}</span>}
      {meta && <span className="lx-rm">{meta}</span>}
    </button>
  );
}

function Properties({
  task,
  focusRun,
  agentRun,
  ccRun,
  onCopy,
  onOpenCC,
}: {
  task: TaskDetail;
  focusRun?: RunView;
  agentRun?: RunView;
  ccRun?: RunView;
  onCopy: (text: string, what: string) => void;
  onOpenCC: (run: RunView) => void;
}) {
  const open = ccRun?.status === 'running' || ccRun?.status === 'waiting';
  const cmd = ccRun ? (open ? ccRun.openCommand : ccRun.forkCommand ?? ccRun.openCommand) : null;
  return (
    <aside className="lx-props" aria-label="Properties">
      <div>
        <p className="lx-ph">Properties</p>
        <dl style={{ margin: 0 }}>
          <div className="lx-prop">
            <dt>Status</dt>
            <dd>
              <TaskStatusIcon task={task} />
              <span title={task.status === 'needs_you' ? reasonText(task.inboxReason) : undefined}>{TASK_STATUS_LABEL[task.status]}</span>
            </dd>
          </div>
          <div className="lx-prop">
            <dt>Step</dt>
            <dd>
              {focusRun && <RunStatusIcon status={focusRun.status} outcome={focusRun.outcome} />}
              <span>
                {task.currentStepTitle ?? (task.status === 'done' ? 'Finished' : '—')}
                {focusRun && focusRun.stepId === task.currentStep && focusRun.attempt > 1 ? ` · attempt ${focusRun.attempt}` : ''}
              </span>
            </dd>
          </div>
          <div className="lx-prop">
            <dt>Agent</dt>
            <dd>
              {agentRun ? (
                <>
                  <AgentAvatar run={agentRun} />
                  <span>{agentOf(agentRun).name}</span>
                </>
              ) : (
                <span className="lx-hint">None yet</span>
              )}
            </dd>
          </div>
          <div className="lx-prop">
            <dt>Workflow</dt>
            <dd>
              <span>{task.workflow}</span>
            </dd>
          </div>
          {task.ref && (
            <div className="lx-prop">
              <dt>Ticket</dt>
              <dd>
                <span className="lx-mono">{task.ref}</span>
              </dd>
            </div>
          )}
          <div className="lx-prop">
            <dt>Started</dt>
            <dd>
              <span title={new Date(task.createdAt).toLocaleString()}>{ago(task.createdAt)}</span>
            </dd>
          </div>
          <div className="lx-prop">
            <dt>Updated</dt>
            <dd>
              <span title={new Date(task.updatedAt).toLocaleString()}>{ago(task.updatedAt)}</span>
            </dd>
          </div>
        </dl>
      </div>
      <div>
        <p className="lx-ph">Session</p>
        <dl style={{ margin: 0 }}>
          <div className="lx-prop">
            <dt>Worktree</dt>
            <dd>
              {task.worktree ? (
                <span className="lx-copyrow">
                  <span className="lx-mono" title={task.worktree}>
                    {task.worktree.replace(/^\/Users\/[^/]+/, '~')}
                  </span>
                  <button className="lx-ib" aria-label="Copy worktree path" onClick={() => onCopy(task.worktree ?? '', 'Worktree path')}>
                    <CopyIcon />
                  </button>
                </span>
              ) : (
                <span className="lx-hint">None</span>
              )}
            </dd>
          </div>
          <div className="lx-prop">
            <dt>Session id</dt>
            <dd>
              {ccRun?.sessionId ? (
                <span className="lx-copyrow">
                  <span className="lx-mono" title={ccRun.sessionId}>
                    {ccRun.sessionId}
                  </span>
                  <button className="lx-ib" aria-label="Copy session id" onClick={() => onCopy(ccRun.sessionId ?? '', 'Session id')}>
                    <CopyIcon />
                  </button>
                </span>
              ) : (
                <span className="lx-hint">None yet</span>
              )}
            </dd>
          </div>
        </dl>
        {ccRun && cmd && (
          <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span className="lx-hint">{open ? 'Resume the open session' : 'Open a copy of the last session'}</span>
            <div className="lx-cmd" style={{ fontSize: 11.5, padding: '7px 8px' }}>
              <code title={cmd}>{cmd}</code>
              <button onClick={() => onCopy(cmd, 'Command')}>Copy</button>
            </div>
            <button className="lx-btn" style={{ alignSelf: 'flex-start' }} onClick={() => onOpenCC(ccRun)}>
              <TerminalIcon size={13} />
              Open in Claude Code
            </button>
          </div>
        )}
      </div>
    </aside>
  );
}
