import type { ReactNode } from 'react';
import { href, type Route } from '../lib/router';
import {
  AgentsIcon,
  BoardIcon,
  InboxIcon,
  LogoIcon,
  PlusIcon,
  RunsIcon,
  SearchIcon,
  SettingsIcon,
  TasksIcon,
  TerminalIcon,
  TriggersIcon,
  WorkflowsIcon,
} from './Icons';

function NavLink({ to, on, icon, label, count }: { to: string; on: boolean; icon: ReactNode; label: string; count?: number }) {
  return (
    <a className={`lx-sbtn${on ? ' lx-on' : ''}`} href={to} aria-current={on ? 'page' : undefined}>
      {icon}
      {label}
      {count ? <span className="lx-n">{count}</span> : null}
    </a>
  );
}

function Soon({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <div className="lx-sbtn lx-soon" aria-disabled="true" title="Coming soon">
      {icon}
      {label}
      <span className="lx-n">soon</span>
    </div>
  );
}

export function Sidebar({
  route,
  inboxCount,
  runningCount,
  queuedCount,
  connected,
  onNewTask,
}: {
  route: Route;
  inboxCount: number;
  runningCount: number;
  queuedCount: number;
  connected: boolean;
  onNewTask: () => void;
}) {
  const tasksOn = route.name === 'tasks' || route.name === 'task';
  return (
    <aside className="lx-side" aria-label="Sidebar">
      <div className="lx-ws">
        <span className="lx-logo">
          <LogoIcon />
        </span>
        Orstra
      </div>
      <button className="lx-btn lx-newtask" onClick={onNewTask}>
        <PlusIcon />
        New task
      </button>
      <div className="lx-sbtn lx-soon" aria-disabled="true" title="Search is coming soon">
        <SearchIcon />
        Search
        <span className="lx-n">soon</span>
      </div>
      <NavLink to={href.inbox} on={route.name === 'inbox'} icon={<InboxIcon />} label="Inbox" count={inboxCount} />
      <NavLink to={href.sessions} on={route.name === 'sessions'} icon={<TerminalIcon />} label="Sessions" count={runningCount} />
      <div className="lx-group">Factory</div>
      <NavLink to={href.tasks} on={tasksOn} icon={<TasksIcon />} label="Tasks" />
      <Soon icon={<BoardIcon />} label="Board" />
      <Soon icon={<RunsIcon />} label="Runs" />
      <Soon icon={<WorkflowsIcon />} label="Workflows" />
      <Soon icon={<TriggersIcon />} label="Triggers" />
      <Soon icon={<AgentsIcon />} label="Agents" />
      <Soon icon={<SettingsIcon />} label="Settings" />
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
