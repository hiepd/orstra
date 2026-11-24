import { useState } from 'react';
import type { GitView, RunView, TaskDetail } from '../api';
import { ChatBox } from '../components/ChatBox';
import { useAutoScroll } from '../lib/autoScroll';
import { GitPanel } from '../components/GitPanel';
import { PanelIcon } from '../components/Icons';
import { Transcript } from '../components/Transcript';
import { agentOf, humanize } from '../lib/format';
import type { Resource } from '../lib/live';
import { remember, store } from '../lib/remember';
import { href } from '../lib/router';
import { taskState } from '../lib/taskState';
import { clock, duration } from '../lib/time';

export const runName = (task: TaskDetail, r: RunView) => r.stepTitle + (r.attempt > 1 || task.runs.some((x) => x.stepId === r.stepId && x.id !== r.id) ? ` · ${r.kind === 'human' ? 'round' : 'attempt'} ${r.attempt}` : '');

/** Where the Chat view remembers whether its Sessions panel is open. */
const SESSIONS_KEY = 'orstra.chat.sessions';

/** Agent runs that have a session, newest first. One session per agent run. */
export const sessionsOf = (task: TaskDetail) => task.runs.filter((r) => r.kind === 'agent' && r.sessionId).reverse();

/** The session to show when none is picked: the one working or waiting on you, else the newest. */
export function defaultSession(task: TaskDetail): RunView | undefined {
  const all = sessionsOf(task);
  return all.find((r) => r.id === task.workingRunId) ?? all.find((r) => r.id === task.awaiting?.runId) ?? all[0];
}

/**
 * The agent view of a task: its sessions on the left (you can collapse them), the chat with the
 * selected one in the middle, and the worktree (branch, PR, changes, checks, commits) on the right.
 */
export function TaskChat({ task, runId, git, openPath, onOpenPath, embedded }: { task: TaskDetail; runId?: string; git: Resource<GitView>; openPath: string | null; onOpenPath: (p: string | null) => void; embedded?: boolean }) {
  const sessions = sessionsOf(task);
  const run = sessions.find((r) => r.id === runId) ?? defaultSession(task);
  const [reopened, setReopened] = useState<Record<string, boolean>>({});
  const [sessionsOpen, setSessionsOpen] = useState(() => remember(SESSIONS_KEY, 'open') === 'open');
  const events = run ? task.events.filter((e) => e.runId === run.id) : [];
  const scroll = useAutoScroll<HTMLDivElement>(`${run?.id}:${events.length}`);

  const toggleSessions = () => {
    const next = !sessionsOpen;
    setSessionsOpen(next);
    store(SESSIONS_KEY, next ? 'open' : 'closed');
  };

  const state = (r: RunView) => {
    const working = r.id === task.workingRunId || (!!r.live && r.status === 'running');
    const waiting = r.status === 'waiting' && taskState(task) !== 'stopped';
    return { working, waiting, live: working || !!r.live };
  };

  return (
    <div className="ox-chatv">
      {sessionsOpen && !embedded && (
        <nav className="ox-sess" aria-label="Sessions">
          <div className="ox-sessh">
            Sessions
            <button className="lx-ib ox-sessb" aria-expanded={true} aria-label="Collapse the sessions" title="Collapse" onClick={toggleSessions}>
              <PanelIcon size={14} />
            </button>
          </div>
          {sessions.map((r) => {
            const s = state(r);
            const a = agentOf(r);
            const meta = s.working ? 'working' : s.waiting ? 'waiting for you' : r.status === 'queued' ? 'queued' : `ended · ${humanize(r.outcome ?? r.status).toLowerCase()} · ${duration(r.startedAt, r.endedAt ?? r.startedAt)}`;
            return (
              <a key={r.id} className="ox-srow" href={href.chat(task.id, r.id)} aria-current={r.id === run?.id ? 'true' : undefined}>
                <span className={`ox-sd${s.working ? ' ox-live' : ''}`} style={{ background: s.working ? '#3B82F6' : s.waiting ? 'var(--purple-fg)' : 'var(--border-strong)' }} />
                <span className="ox-sname">{runName(task, r)}</span>
                <span className="ox-smeta">
                  {meta} · {a.name}
                </span>
              </a>
            );
          })}
          {sessions.length === 0 && <div className="lx-hint" style={{ padding: '4px 8px' }}>None yet.</div>}
          <div className="lx-hint" style={{ padding: '10px 8px 0', lineHeight: 1.5 }}>
            One session per agent run. Checks and decisions have no session; see Overview.
          </div>
        </nav>
      )}

      <section className={`ox-chat${sessionsOpen ? '' : ' ox-chatx'}`} aria-label="Chat">
        {!sessionsOpen && (
          <button className="lx-ib ox-sessx" aria-expanded={false} aria-label="Expand the sessions" title="Sessions" onClick={toggleSessions}>
            <PanelIcon size={15} />
          </button>
        )}
        {run ? (
          (() => {
            const s = state(run);
            const a = agentOf(run);
            const canTalk = s.working || s.waiting || !!reopened[run.id] || !!run.live;
            return (
              <>
                <div className="ox-cscroll" ref={scroll.ref} onScroll={scroll.onScroll}>
                  <div className="ox-lane">
                    <div className="ox-sline">
                      {a.name} · {runName(task, run)} · started {run.startedAt ? clock(run.startedAt) : 'not yet'} · session {run.sessionId?.slice(0, 8)}
                    </div>
                    <Transcript run={run} events={events} working={s.working} agentName={a.name} />
                  </div>
                </div>
                <div className="ox-compwrap">
                  {canTalk ? (
                    <ChatBox
                      key={run.id}
                      taskId={task.id}
                      runId={run.id}
                      working={s.working}
                      canStop={run.id === task.workingRunId}
                      waiting={s.waiting}
                      reopened={!s.working && !s.waiting}
                      who={a.name}
                      av={a.av}
                      color={a.color}
                      branch={git.data?.branch ?? null}
                    />
                  ) : (
                    <div className="ox-ended">
                      <span style={{ flex: 1 }}>
                        This session ended{run.outcome ? ` (${humanize(run.outcome).toLowerCase()})` : ''}. Reopen it to ask questions; the task doesn’t move.
                      </span>
                      <button className="lx-btn" onClick={() => setReopened((m) => ({ ...m, [run.id]: true }))}>
                        Reopen session
                      </button>
                    </div>
                  )}
                </div>
              </>
            );
          })()
        ) : (
          <div className="ox-cempty">
            <b>No session yet</b>
            <span>A session starts when the task’s first agent step runs.</span>
            <span>
              You can leave notes for its steps in <a href={href.task(task.id)}>Overview</a>.
            </span>
          </div>
        )}
      </section>

      {!embedded && <GitPanel task={task} git={git} openPath={openPath} onOpenPath={onOpenPath} />}
    </div>
  );
}
