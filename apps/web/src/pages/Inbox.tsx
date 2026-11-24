import { useEffect, useState, type ReactNode } from 'react';
import { api, type TaskDetail } from '../api';
import { InboxIcon, StuckCircle, WaitCircle } from '../components/Icons';
import { AGENTS, reasonText, taskLabel } from '../lib/format';
import { useLiveResource, useNow } from '../lib/live';
import { href, type TaskViewName } from '../lib/router';
import { TaskPage } from './TaskPage';
import { STATE, stepLabel, taskState, type TaskState } from '../lib/taskState';
import { ago } from '../lib/time';
import { pickInboxTask, type InboxPick } from '../lib/inboxPick';

const GROUPS: { state: TaskState; name: string; icon: ReactNode }[] = [
  { state: 'decision', name: 'Decide', icon: <WaitCircle label="Decision" /> },
  { state: 'waiting_you', name: 'Agents waiting for you', icon: <WaitCircle label="Waiting for you" /> },
  { state: 'paused', name: 'Sessions that closed', icon: <StuckCircle /> },
  { state: 'blocked', name: 'Stuck', icon: <StuckCircle /> },
];

const firstLine = (s: string) => s.split('\n').find((l) => l.trim()) ?? '';

/** What a task needs from you, in one line. */
function what(t: TaskDetail, state: TaskState): string {
  if (state === 'decision') return t.human?.question ?? 'Waiting for your decision';
  if (state === 'waiting_you') return t.awaiting?.text ? `“${firstLine(t.awaiting.text)}”` : reasonText(t.stateReason);
  if (state === 'paused') return 'Its session is closed. Message it and it picks the work back up.';
  return reasonText(t.stateReason);
}

/**
 * The Inbox view of Tasks: every task that needs you, across workflows. Pick a row and the task opens
 * beside the list (Overview or Chat), so you can decide, answer or retry without leaving the Inbox.
 */
export function InboxView({ sel, selView }: { sel?: string; selView?: TaskViewName }) {
  useNow(30_000);
  const res = useLiveResource('inbox', api.inbox);
  const tasks = useLiveResource('inbox:tasks', api.tasks);
  const all = res.data ?? [];
  const groups = GROUPS.map((g) => ({ ...g, items: all.filter((t) => taskState(t) === g.state).sort((a, b) => a.updatedAt - b.updatedAt) })).filter((g) => g.items.length > 0);
  const ordered = groups.flatMap((g) => g.items);
  const count = (group: string) => tasks.data?.filter((t) => STATE[taskState(t)].group === group).length ?? 0;
  const running = count('running');
  const queued = count('queued');
  // The open task stays open after it leaves the list (you answered it, so it runs now), until you pick another.
  const [kept, setKept] = useState<InboxPick | null>(null);
  const picked = pickInboxTask({ sel, selView, kept, list: ordered.map((t) => ({ id: t.id, state: taskState(t) })) });
  useEffect(() => {
    if (picked && (picked.id !== kept?.id || picked.view !== kept?.view)) setKept(picked);
  }, [picked?.id, picked?.view]); // eslint-disable-line react-hooks/exhaustive-deps
  const left = picked && res.data && !ordered.some((t) => t.id === picked.id) ? tasks.data?.find((t) => t.id === picked.id) : undefined;

  return (
    <div className="ox-isplit">
      <section className="ox-ilist" aria-label="Needs you">
        <div>
          <h1 className="ox-h1">Inbox</h1>
          <div className="ox-sub">
            {res.data
              ? all.length
                ? `${all.length} ${all.length === 1 ? 'task needs' : 'tasks need'} you. About ${all.length * 2} minutes of your time.`
                : 'You are all caught up.'
              : 'Loading…'}
          </div>
        </div>
        {res.error && !res.data && <div className="lx-error">{res.error}</div>}
        {res.data && all.length === 0 && (
          <div className="lx-empty" style={{ padding: '40px 0 8px' }}>
            <span style={{ color: 'var(--dim)' }}>
              <InboxIcon />
            </span>
            <b>Nothing needs you</b>
            <span>Decisions, questions from agents and stuck tasks show up here.</span>
          </div>
        )}
        {groups.map((g) => (
          <section key={g.state}>
            <h2 className="ox-gh">
              {g.name}
              <span className="ox-gn">{g.items.length}</span>
            </h2>
            <div className="ox-card">
              {g.items.map((t) => {
                const a = AGENTS[t.agent ?? 'claude-code'];
                const on = picked?.id === t.id;
                return (
                  <a key={t.id} className="ox-irow" aria-current={on ? 'true' : undefined} href={href.inboxTask(t.id, g.state === 'waiting_you' || g.state === 'paused' ? 'chat' : 'overview')}>
                    <span className="ox-iic" style={{ background: STATE[g.state].bg }}>
                      {g.icon}
                    </span>
                    <span className="ox-imain">
                      <span className="ox-iline">
                        <span className="ox-id">{taskLabel(t)}</span>
                        <span className="ox-iname">{t.title}</span>
                      </span>
                      <span className="ox-iwhat">{what(t, g.state)}</span>
                      <span className="ox-imeta">
                        <span className="lx-av ox-av" style={{ background: a.color }}>
                          {a.av}
                        </span>
                        <span>
                          {a.name} · {stepLabel(t)} · {ago(t.updatedAt)}
                        </span>
                      </span>
                    </span>
                  </a>
                );
              })}
            </div>
          </section>
        ))}
        {left && (
          <section>
            <h2 className="ox-gh">No longer needs you</h2>
            <div className="ox-card">
              <a className="ox-irow" aria-current="true" href={href.inboxTask(left.id, picked!.view)}>
                <span className="ox-iic" style={{ background: STATE[taskState(left)].bg }}>
                  <span className={`ox-sd${taskState(left) === 'working' ? ' ox-live' : ''}`} style={{ background: 'var(--accent)' }} />
                </span>
                <span className="ox-imain">
                  <span className="ox-iline">
                    <span className="ox-id">{taskLabel(left)}</span>
                    <span className="ox-iname">{left.title}</span>
                  </span>
                  <span className="ox-iwhat">
                    {STATE[taskState(left)].label} · {stepLabel(left)}
                  </span>
                </span>
              </a>
            </div>
          </section>
        )}
        {tasks.data && (running > 0 || queued > 0) && (
          <div className="ox-calm">
            <span className="ox-sd ox-live" style={{ background: 'var(--accent)' }} />
            <span>
              {running} {running === 1 ? 'task is' : 'tasks are'} running and {queued} queued.{all.length ? ' Nothing else needs you.' : ''}
            </span>
          </div>
        )}
      </section>
      <div className="ox-ipane">
        {picked ? (
          <TaskPage key={picked.id} id={picked.id} view={picked.view} embedded />
        ) : (
          <div className="lx-empty">
            <b>{res.data ? 'Nothing needs you' : 'Loading…'}</b>
            <span>Agents keep working. A task shows up here when a step needs you.</span>
          </div>
        )}
      </div>
    </div>
  );
}
