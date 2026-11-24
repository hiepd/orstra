import type { ReactNode } from 'react';
import { api, type TaskDetail } from '../api';
import { ChevronRight, InboxIcon, StuckCircle, WaitCircle } from '../components/Icons';
import { AGENTS, reasonText, taskLabel } from '../lib/format';
import { useLiveResource, useNow } from '../lib/live';
import { href } from '../lib/router';
import { STATE, stepLabel, taskState, type TaskState } from '../lib/taskState';
import { ago } from '../lib/time';

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

/** Every task that needs you. Rows only open the task; you act there. */
export function InboxPage() {
  useNow(30_000);
  const res = useLiveResource('inbox', api.inbox);
  const tasks = useLiveResource('inbox:tasks', api.tasks);
  const all = res.data ?? [];
  const groups = GROUPS.map((g) => ({ ...g, items: all.filter((t) => taskState(t) === g.state).sort((a, b) => a.updatedAt - b.updatedAt) })).filter((g) => g.items.length > 0);
  const count = (group: string) => tasks.data?.filter((t) => STATE[taskState(t)].group === group).length ?? 0;
  const running = count('running');
  const queued = count('queued');

  return (
    <>
      <div className="lx-bar">
        <span className="lx-crumb">
          <b>Inbox</b>
        </span>
        {res.data && <span className="lx-muted">{all.length ? `${all.length} ${all.length === 1 ? 'task needs' : 'tasks need'} you` : 'Nothing needs you'}</span>}
      </div>
      <div className="ox-scroll">
        <div className="ox-col">
          {res.error && !res.data && <div className="lx-error">{res.error}</div>}
          {res.loading && !res.data && !res.error && (
            <div className="lx-loading">
              <span className="lx-spin" /> Loading…
            </div>
          )}
          {res.data && all.length === 0 && (
            <div className="lx-empty" style={{ padding: '48px 0 8px' }}>
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
                  return (
                    <a key={t.id} className="ox-irow" href={g.state === 'waiting_you' || g.state === 'paused' ? href.chat(t.id) : href.task(t.id)}>
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
                      <span className="ox-go">
                        <ChevronRight size={14} />
                      </span>
                    </a>
                  );
                })}
              </div>
            </section>
          ))}
          {tasks.data && (running > 0 || queued > 0) && (
            <div className="ox-calm">
              <span className="ox-sd ox-live" style={{ background: 'var(--accent)' }} />
              <span>
                {running} {running === 1 ? 'task is' : 'tasks are'} running and {queued} queued. {all.length ? 'Nothing else needs you.' : ''}
              </span>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
