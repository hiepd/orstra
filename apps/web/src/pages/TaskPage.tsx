import { useCallback, useMemo, useState } from 'react';
import { api, errorMessage, taskLoader, type GitView, type RunView, type TaskDetail } from '../api';
import { ClaudeCodeModal } from '../components/ClaudeCodeModal';
import { AwaitingCard, DecisionCard, PermissionCard, RetryModal, StopModal, StuckBanner } from '../components/Decision';
import { prName, shortPath, useGit } from '../components/GitPanel';
import { ChevronRight, TerminalIcon } from '../components/Icons';
import { Menu, Modal, useToast } from '../components/Overlay';
import { ProgressList } from '../components/ProgressList';
import { AgentAvatar, RunStatusIcon } from '../components/Status';
import { currentRun, describeTask } from '../lib/describe';
import { agentOf, humanize, money, taskLabel, tokens } from '../lib/format';
import { useLiveResource, useNow, type Resource } from '../lib/live';
import { href, type TaskViewName } from '../lib/router';
import { STATE, stepLabel, taskState } from '../lib/taskState';
import { ago, clock, duration } from '../lib/time';
import { defaultSession, runName, TaskChat } from './TaskChat';

type ModalState = { kind: 'retry'; stepId?: string } | { kind: 'stop' } | { kind: 'cc'; run: RunView } | { kind: 'note'; stepId: string; title: string } | { kind: 'cleanup' } | null;

export function TaskPage({ id, view, runId }: { id: string; view: TaskViewName; runId?: string }) {
  // Each refetch asks only for the events the page has not seen yet.
  const load = useMemo(() => taskLoader(id), [id]);
  const res = useLiveResource(`task:${id}`, load, (taskId) => taskId === id);
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
  return <TaskView task={task} view={view} runId={runId} />;
}

/** One task, two views: Overview (where it is and what happened) and Chat (the agent sessions and the worktree). */
function TaskView({ task, view, runId }: { task: TaskDetail; view: TaskViewName; runId?: string }) {
  const toast = useToast();
  useNow(15_000);
  const git = useGit(task.id);
  const [modal, setModal] = useState<ModalState>(null);
  const [editorMenu, setEditorMenu] = useState(false);
  const [openPath, setOpenPath] = useState<string | null>(null);
  const closeMenu = useCallback(() => setEditorMenu(false), []);

  const state = taskState(task);
  const ccRun = (view === 'chat' && runId ? task.runs.find((r) => r.id === runId && r.sessionId) : undefined) ?? defaultSession(task);
  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(task.worktree ?? '');
      toast('Worktree path copied');
    } catch {
      toast('Couldn’t copy to the clipboard', { error: true });
    }
  };

  return (
    <>
      <div className="lx-bar">
        <div className="lx-crumb">
          <a href={href.tasks}>Tasks</a>
          <span>›</span>
          <span className="ox-id">{taskLabel(task)}</span>
          <b className="ox-trunc">{task.title}</b>
        </div>
        <span className="ox-pill" style={{ background: STATE[state].bg, color: STATE[state].fg }}>
          <span className={`ox-sd${state === 'running' ? ' ox-live' : ''}`} style={{ background: STATE[state].fg }} />
          {STATE[state].label}
        </span>
        <div className="ox-seg" role="group" aria-label="Task view" style={{ marginLeft: 10 }}>
          <a href={href.task(task.id)} aria-current={view === 'overview' ? 'page' : undefined}>
            Overview
          </a>
          <a href={href.chat(task.id)} aria-current={view === 'chat' ? 'page' : undefined}>
            Chat
          </a>
        </div>
        <div className="lx-acts">
          {task.worktree && (
            <>
              <button className="lx-btn" aria-expanded={editorMenu} onClick={() => setEditorMenu((m) => !m)}>
                Open in editor
              </button>
              {editorMenu && (
                <Menu onClose={closeMenu} style={{ right: ccRun ? 168 : 0, top: 34 }} label="Open the worktree">
                  <a role="menuitem" href={`vscode://file${encodeURI(task.worktree)}`} onClick={closeMenu}>
                    VS Code
                  </a>
                  <a role="menuitem" href={`cursor://file${encodeURI(task.worktree)}`} onClick={closeMenu}>
                    Cursor
                  </a>
                  <hr />
                  <button
                    role="menuitem"
                    onClick={() => {
                      closeMenu();
                      void copyPath();
                    }}
                  >
                    Copy worktree path
                  </button>
                </Menu>
              )}
            </>
          )}
          {ccRun && (
            <button className="lx-btn" onClick={() => setModal({ kind: 'cc', run: ccRun })}>
              <TerminalIcon size={13} strokeWidth={2.2} />
              Open in {agentOf(ccRun).name}
            </button>
          )}
        </div>
      </div>

      {view === 'overview' ? (
        <Overview task={task} git={git} onModal={setModal} />
      ) : (
        <TaskChat task={task} runId={runId} git={git} openPath={openPath} onOpenPath={setOpenPath} />
      )}

      {modal?.kind === 'retry' && <RetryModal task={task} stepId={modal.stepId} onClose={() => setModal(null)} />}
      {modal?.kind === 'stop' && <StopModal task={task} onClose={() => setModal(null)} />}
      {modal?.kind === 'cc' && <ClaudeCodeModal run={modal.run} crumb={taskLabel(task)} onClose={() => setModal(null)} />}
      {modal?.kind === 'note' && <NoteModal task={task} stepId={modal.stepId} title={modal.title} onClose={() => setModal(null)} />}
      {modal?.kind === 'cleanup' && <CleanupModal task={task} onClose={() => setModal(null)} />}
    </>
  );
}

const KIND: Record<string, string> = { agent: 'agent', gate: 'checks', human: 'your decision', switch: 'picks a branch', action: 'action', workflow: 'starts a workflow' };
const TONE = {
  ok: { bg: 'var(--green-soft)', fg: 'var(--green-fg)' },
  fail: { bg: 'var(--red-soft)', fg: 'var(--red-fg)' },
  live: { bg: 'var(--accent-soft)', fg: 'var(--accent-fg)' },
  wait: { bg: 'var(--purple-soft)', fg: 'var(--purple-fg)' },
  back: { bg: 'var(--orange-soft)', fg: 'var(--orange-fg)' },
  plain: { bg: 'var(--line-3)', fg: 'var(--grey-fg)' },
};

/** How a run ended, as a badge: "done", "fail → Implement", "waiting for you". */
function outcomeBadge(task: TaskDetail, r: RunView): { text: string; tone: keyof typeof TONE } {
  if (r.status === 'running') return { text: 'running', tone: 'live' };
  if (r.status === 'queued') return { text: 'queued', tone: 'plain' };
  if (r.status === 'waiting') return { text: 'waiting for you', tone: 'wait' };
  if (r.status === 'stopped') return { text: 'stopped', tone: 'plain' };
  const outcome = r.outcome ?? r.status;
  const to = task.steps.find((s) => s.id === r.stepId)?.on[outcome];
  const order = task.track.map((s) => s.title);
  const loopsBack = !!to && to !== 'end' && order.indexOf(to) >= 0 && order.indexOf(to) <= order.indexOf(r.stepTitle);
  const text = humanize(outcome).toLowerCase() + (loopsBack ? ` → ${to}` : '');
  if (r.status === 'failed') return { text, tone: 'fail' };
  if (loopsBack) return { text, tone: 'back' };
  return { text, tone: r.kind === 'switch' ? 'plain' : 'ok' };
}

function Overview({ task, git, onModal }: { task: TaskDetail; git: Resource<GitView>; onModal: (m: ModalState) => void }) {
  const state = taskState(task);
  const { now, next } = describeTask(task);
  const cur = currentRun(task);
  const active = task.status === 'running' || task.status === 'needs_you';
  const lastIdx = task.runs.length - 1;
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const isOpen = (r: RunView, i: number) => open[r.id] ?? i === lastIdx;

  // Steps that haven't run yet in this pass, plus the current one while it is still queued: these can take a note.
  const upcoming = task.track.filter((s) => s.state === 'todo' || (s.state === 'current' && cur?.status === 'queued'));
  const agentRun = [...task.runs].reverse().find((r) => r.kind === 'agent');
  const g = git.data;

  /** What a non-agent run did, in a sentence, from the task's events. */
  const runText = (r: RunView): string | null => {
    if (r.status === 'running' && r.kind === 'agent') return 'Running now. Open Chat to watch it or talk to it.';
    if (r.status === 'waiting' && r.kind === 'agent') return 'The session is open and waiting for you.';
    if (r.kind === 'human') {
      const d = task.events.find((e) => e.runId === r.id && e.kind === 'you' && e.mode === 'decision');
      if (d && d.kind === 'you') return `${d.via === 'cos' ? 'Your chief of staff chose (with your OK)' : 'You chose'} “${humanize(d.choice ?? r.outcome ?? '').toLowerCase()}”.` + (d.text ? ` Comment: “${d.text}”` : '');
      return r.status === 'waiting' ? 'Waiting for your decision.' : null;
    }
    if (r.kind === 'switch' || r.kind === 'action') {
      const sys = task.events.find((e) => e.runId === r.id && e.kind === 'system');
      return sys && sys.kind === 'system' ? sys.text : null;
    }
    return null;
  };

  return (
    <div className="ox-ov">
      <div className="ox-ovmain">
        <div className="ox-ovcol">
          <div>
            <h1 className="ox-h1">{task.title}</h1>
            <div className="ox-sub">
              {task.ref ? `${task.ref} · ` : ''}
              {task.workflow} · started {ago(task.createdAt)}
            </div>
          </div>

          <section className="ox-where" aria-label="Where this task is">
            {task.track.length > 0 && (
              <div className="ox-track">
                {task.track.map((s) => (
                  <div key={s.id} className={`ox-tstep${s.state === 'done' ? ' ox-done' : s.state === 'current' ? ` ox-cur ox-cur-${state}` : ''}`}>
                    <span className="ox-tdot">
                      {s.state === 'done' && (
                        <svg width="10" height="10" viewBox="0 0 12 12" aria-hidden="true">
                          <path d="m2.5 6.2 2.3 2.3 4.7-5" fill="none" stroke="#FFFFFF" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      )}
                    </span>
                    <span className="ox-tname">{s.title}</span>
                  </div>
                ))}
              </div>
            )}
            <p className="ox-now">{now}</p>
            <div className="ox-next">
              <span className="ox-k">Next</span>
              <span>{next}</span>
            </div>
          </section>

          {task.human && (
            <div>
              <DecisionCard task={task} />
              {g && g.files.length > 0 && (
                <a className="ox-link" style={{ display: 'inline-block', marginTop: 8 }} href={href.chat(task.id)}>
                  See what it changed ({g.files.length} {g.files.length === 1 ? 'file' : 'files'}) in Chat →
                </a>
              )}
            </div>
          )}
          {task.archivedAt && (
            <div className="ox-calm">
              Archived {ago(task.archivedAt)}. It is out of the lists, and nothing runs for it.{' '}
              <button className="ox-link" onClick={() => void api.archive(task.id, false)}>
                Bring it back
              </button>
            </div>
          )}
          {task.permission && <PermissionCard task={task} />}
          {!task.human && !task.permission && task.awaiting && (
            <AwaitingCard task={task}>
              <div>
                <a className="lx-btn lx-pri" href={href.chat(task.id, task.awaiting.runId)}>
                  Answer in Chat
                </a>
              </div>
            </AwaitingCard>
          )}
          {!task.human && !task.awaiting && task.status === 'needs_you' && <StuckBanner task={task} />}

          {task.description && (
            <section>
              <h2 className="ox-h2">Description</h2>
              <p className="ox-desc">{task.description}</p>
            </section>
          )}

          <section>
            <h2 className="ox-h2">
              Runs<span className="ox-gn">{task.runs.length}</span>
            </h2>
            {task.runs.length > 0 ? (
              <div className="ox-card">
                {task.runs.map((r, i) => {
                  const badge = outcomeBadge(task, r);
                  const text = runText(r);
                  const o = isOpen(r, i);
                  const byCos = task.events.some((e) => e.runId === r.id && e.kind === 'you' && e.mode === 'decision' && e.via === 'cos');
                  const who = r.kind === 'agent' || r.kind === 'gate' ? agentOf(r).name : r.kind === 'human' ? (byCos ? 'Chief of staff' : 'You') : 'Orstra';
                  return (
                    <div key={r.id} className="ox-run">
                      <button className="ox-runh" aria-expanded={o} onClick={() => setOpen((m) => ({ ...m, [r.id]: !o }))}>
                        <RunStatusIcon status={r.status} outcome={r.outcome} />
                        <span className="ox-rname">{runName(task, r)}</span>
                        <span className="ox-rwho">
                          {r.kind === 'agent' || r.kind === 'gate' ? <AgentAvatar run={r} /> : null}
                          {who}
                        </span>
                        <span className="ox-rdur" title={r.startedAt ? `Started ${clock(r.startedAt)}${r.tokensIn ? ` · ${tokens(r.tokensIn)} tokens in, ${tokens(r.tokensOut)} out` : ''}` : undefined}>
                          {r.startedAt ? duration(r.startedAt, r.endedAt ?? Date.now()) : '—'}
                          {r.costUsd ? ` · ${money(r.costUsd)}` : ''}
                        </span>
                        <span className="ox-oc" style={{ background: TONE[badge.tone].bg, color: TONE[badge.tone].fg }}>
                          {badge.text}
                        </span>
                        <ChevronRight open={o} size={11} />
                      </button>
                      {o && (
                        <div className="ox-runb">
                          {text && <div className="ox-rtext">{text}</div>}
                          {r.progress && <ProgressList progress={r.progress} />}
                          {r.output && <pre className="ox-pre">{r.output.trim().split('\n').slice(-30).join('\n')}</pre>}
                          {!text && !r.progress && !r.output && <div className="lx-hint">Nothing recorded for this run.</div>}
                          <div className="ox-brow">
                            {r.sessionId && (
                              <a className="ox-link" href={href.chat(task.id, r.id)}>
                                {r.status === 'running' || r.status === 'waiting' ? 'Open the live session in Chat →' : 'Open this session in Chat →'}
                              </a>
                            )}
                            {active && r.status !== 'running' && r.status !== 'queued' && r.kind !== 'human' && r.kind !== 'switch' && (
                              <button className="ox-link" onClick={() => onModal({ kind: 'retry', stepId: r.stepId })}>
                                Re-run this step…
                              </button>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="ox-calm">No runs yet. The first step starts when a slot is free.</div>
            )}
            <div className="lx-hint" style={{ marginTop: 8 }}>
              A run is one step executed once. A retry is a new run with a fresh session; it reads the earlier runs’ progress notes.
            </div>
          </section>

          {active && upcoming.length > 0 && (
            <section>
              <h2 className="ox-h2">
                Up next<span className="ox-gn">{upcoming.length}</span>
              </h2>
              <div className="ox-card">
                {upcoming.map((s) => {
                  const notes = task.notes[s.id] ?? [];
                  return (
                    <div key={s.id} className="ox-urow">
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={{ fontWeight: 500 }}>{s.title}</span>
                          <span className="ox-ukind">{KIND[s.kind] ?? s.kind}</span>
                        </div>
                        {notes.map((n) => (
                          <div key={n.ts} className="ox-note">
                            {n.text}
                          </div>
                        ))}
                      </div>
                      {s.kind === 'agent' && (
                        <button className="ox-link" onClick={() => onModal({ kind: 'note', stepId: s.id, title: s.title })}>
                          + Add a note
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
              <div className="lx-hint" style={{ marginTop: 8 }}>
                These are the steps the task reaches if each one succeeds. A note is read by that step’s agent when it runs. To talk to an agent that is running now, use Chat.
              </div>
            </section>
          )}
        </div>
      </div>

      <aside className="ox-props" aria-label="Task details">
        <Prop k="Status" v={STATE[state].label} />
        <Prop k="Step" v={stepLabel({ ...task, run: cur ? { status: cur.status, attempt: cur.attempt, kind: cur.kind } : null })} />
        <div className="ox-prop">
          <span className="ox-pk">Workflow</span>
          <a className="ox-pv" href={href.workflow(task.workflowFile)}>
            {task.workflow}
          </a>
        </div>
        <Prop k="Agent" v={agentRun ? agentOf(agentRun).name : 'None yet'} />
        {task.ref && <Prop k="Ticket" v={task.ref} mono />}
        <Prop k="Branch" v={g?.branch ? g.branch + (g.base ? ` → ${g.base}` : '') : task.worktree ? '…' : 'None'} mono />
        <Prop k="Worktree" v={task.worktree ? shortPath(task.worktree) : 'None'} mono />
        <Prop k="Changes" v={g ? (g.files.length ? `${g.files.length} ${g.files.length === 1 ? 'file' : 'files'} · ${g.commits.length} ${g.commits.length === 1 ? 'commit' : 'commits'}` : 'None yet') : '…'} />
        {task.prUrl ? (
          <div className="ox-prop">
            <span className="ox-pk">PR</span>
            <a className="ox-pv" href={task.prUrl} target="_blank" rel="noreferrer">
              {prName(task.prUrl)}
            </a>
          </div>
        ) : (
          <Prop k="PR" v="Not opened yet" />
        )}
        <Prop
          k="Cost"
          v={task.cost.usd || task.cost.tokensIn ? `${money(task.cost.usd)} · ${tokens(task.cost.tokensIn + task.cost.tokensOut)} tokens` : 'Nothing yet'}
          title="Claude Code's own estimate. Codex reports tokens only."
        />
        <Prop k="Started" v={ago(task.createdAt)} title={new Date(task.createdAt).toLocaleString()} />
        <Prop k="Updated" v={ago(task.updatedAt)} title={new Date(task.updatedAt).toLocaleString()} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 14 }}>
          <a className="lx-btn" style={{ justifyContent: 'center' }} href={href.chat(task.id)}>
            Open Chat
          </a>
          {active && task.currentStep && (
            <button className="lx-btn" style={{ justifyContent: 'center' }} onClick={() => onModal({ kind: 'retry' })}>
              Re-run the current step…
            </button>
          )}
          {active && (
            <button className="lx-btn lx-dan" style={{ justifyContent: 'center' }} onClick={() => onModal({ kind: 'stop' })}>
              Stop task…
            </button>
          )}
          {!active && !task.archivedAt && (
            <>
              <button className="lx-btn" style={{ justifyContent: 'center' }} onClick={() => void api.archive(task.id, true)}>
                Archive
              </button>
              {task.worktree && (
                <button className="lx-btn" style={{ justifyContent: 'center' }} onClick={() => onModal({ kind: 'cleanup' })}>
                  Clean up worktree…
                </button>
              )}
            </>
          )}
        </div>
        {task.workflowChanged && (
          <div className="lx-hint" style={{ marginTop: 14 }}>
            The workflow file changed after this task started. The task still follows the version it started with.{' '}
            <WorkflowRefresh task={task} />
          </div>
        )}
      </aside>
    </div>
  );
}

function Prop({ k, v, mono, title }: { k: string; v: string; mono?: boolean; title?: string }) {
  return (
    <div className="ox-prop">
      <span className="ox-pk">{k}</span>
      <span className={mono ? 'ox-pvm' : 'ox-pv'} title={title ?? v}>
        {v}
      </span>
    </div>
  );
}

/** A note for a step that hasn't run yet. Its agent reads it when the step starts. */
function NoteModal({ task, stepId, title, onClose }: { task: TaskDetail; stepId: string; title: string; onClose: () => void }) {
  const toast = useToast();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    try {
      await api.message(task.id, { text: t, mode: 'note', stepId });
      toast(`Note saved. ${title} reads it when it runs.`);
      onClose();
    } catch (err) {
      toast(errorMessage(err), { error: true });
      setBusy(false);
    }
  };
  return (
    <Modal
      crumb={<span>{taskLabel(task)} › Note</span>}
      title={`Note for ${title}`}
      onClose={onClose}
      footer={
        <>
          <button className="lx-btn" onClick={onClose}>
            Cancel
          </button>
          <button className="lx-btn lx-pri" onClick={() => void save()} disabled={!text.trim() || busy}>
            {busy && <span className="lx-spin" aria-hidden="true" />}
            Save note
          </button>
        </>
      }
    >
      <p>Read by this step’s agent when it runs. It is not sent to an agent that is running now; use Chat for that.</p>
      <textarea
        className="lx-field"
        aria-label={`Note for ${title}`}
        placeholder="e.g. Also run the e2e suite"
        value={text}
        onChange={(e) => setText(e.target.value)}
        autoFocus
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void save();
        }}
      />
    </Modal>
  );
}

/** Move the task to the current version of its workflow file. */
function WorkflowRefresh({ task }: { task: TaskDetail }) {
  const toast = useToast();
  return (
    <button
      className="ox-link"
      onClick={async () => {
        try {
          await api.refreshWorkflow(task.id);
          toast('The task now follows the new version');
        } catch (err) {
          toast(errorMessage(err), { error: true });
        }
      }}
    >
      Use the new version
    </button>
  );
}

/**
 * Remove a finished task's worktree, and its branch when it is merged, then archive the task. When
 * Orstra refuses (uncommitted work, or a scratch repository), the reason shows here, with the choice to
 * throw that work away.
 */
function CleanupModal({ task, onClose }: { task: TaskDetail; onClose: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const submit = async (force: boolean) => {
    setBusy(true);
    try {
      const res = await api.cleanup(task.id, force);
      toast(res.text);
      onClose();
    } catch (err) {
      setRefused(errorMessage(err));
      setBusy(false);
    }
  };
  return (
    <Modal
      crumb={<span>{taskLabel(task)} › Clean up</span>}
      title="Clean up this task?"
      onClose={onClose}
      footer={
        <>
          <button className="lx-btn" onClick={onClose}>
            Cancel
          </button>
          {refused ? (
            <button className="lx-btn lx-danfill" onClick={() => void submit(true)} disabled={busy}>
              {busy && <span className="lx-spin" aria-hidden="true" />}
              Throw the work away and clean up
            </button>
          ) : (
            <button className="lx-btn lx-pri" onClick={() => void submit(false)} disabled={busy}>
              {busy && <span className="lx-spin" aria-hidden="true" />}
              Clean up
            </button>
          )}
        </>
      }
    >
      <p>
        Orstra removes the worktree at {task.worktree ? shortPath(task.worktree) : 'its folder'}. It deletes the branch only when your checked-out branch already has
        all its commits. Then it archives the task.
      </p>
      {refused && <p className="lx-error">{refused}</p>}
    </Modal>
  );
}
