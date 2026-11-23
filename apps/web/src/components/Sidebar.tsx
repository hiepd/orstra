import type { ReactNode } from 'react';
import { href, type Route } from '../lib/router';
import { InboxIcon, LogoIcon, SettingsIcon, TasksIcon, WorkflowsIcon } from './Icons';

function NavLink({ to, on, icon, label, count }: { to: string; on: boolean; icon: ReactNode; label: string; count?: number }) {
  return (
    <a className={`lx-sbtn${on ? ' lx-on' : ''}`} href={to} aria-current={on ? 'page' : undefined}>
      {icon}
      {label}
      {count ? <span className="lx-n">{count}</span> : null}
    </a>
  );
}

/** The whole app is four places: what needs you, all tasks, the workflows, and settings. */
export function Sidebar({ route, inboxCount, runningCount, queuedCount, connected }: { route: Route; inboxCount: number; runningCount: number; queuedCount: number; connected: boolean }) {
  return (
    <aside className="lx-side" aria-label="Sidebar">
      <div className="lx-ws">
        <span className="lx-logo">
          <LogoIcon />
        </span>
        Orstra
      </div>
      <NavLink to={href.inbox} on={route.name === 'inbox'} icon={<InboxIcon />} label="Inbox" count={inboxCount} />
      <NavLink to={href.tasks} on={route.name === 'tasks' || route.name === 'task'} icon={<TasksIcon />} label="Tasks" />
      <NavLink to={href.workflows} on={route.name === 'workflows'} icon={<WorkflowsIcon />} label="Workflows" />
      <NavLink to={href.settings} on={route.name === 'settings'} icon={<SettingsIcon />} label="Settings" />
      <div className="lx-runner">
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <i className="lx-dot" style={{ background: connected ? '#4CB782' : '#B4B5BD' }} />
          {connected ? 'Daemon connected' : 'Connecting to the daemon…'}
        </span>
        <span>
          {runningCount} running · {queuedCount} queued
        </span>
      </div>
    </aside>
  );
}
