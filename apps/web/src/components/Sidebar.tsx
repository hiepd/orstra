import type { ReactNode } from 'react';
import type { TaskSummary } from '../api';
import { href, type Route } from '../lib/router';
import { setThemeChoice, useTheme } from '../lib/theme';
import { taskLabel } from '../lib/format';
import { CosIcon, LogoIcon, SettingsIcon, TasksIcon, WorkflowsIcon } from './Icons';

function NavLink({ to, on, icon, label, count }: { to: string; on: boolean; icon: ReactNode; label: string; count?: number }) {
  return (
    <a className={`lx-sbtn${on ? ' lx-on' : ''}`} href={to} aria-current={on ? 'page' : undefined}>
      {icon}
      {label}
      {count ? (
        <span className="lx-n" aria-label={`${count} need you`}>
          {count}
        </span>
      ) : null}
    </a>
  );
}

const SUN = 'M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4l1.4-1.4M17 7l1.4-1.4M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8';
const MOON = 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z';

/**
 * Your assistant, then Tasks (with the count of what needs you) and Workflows. The tasks working right
 * now come next, so you can jump into one. Settings and one status card sit at the bottom: the daemon,
 * what needs you, what runs, what waits, what today cost, and the appearance switch.
 */
export function Sidebar({
  route,
  needsCount,
  running,
  queuedCount,
  costToday,
  connected,
}: {
  route: Route;
  needsCount: number;
  running: TaskSummary[];
  queuedCount: number;
  costToday: number | null;
  connected: boolean;
}) {
  const { resolved } = useTheme();
  const dark = resolved === 'dark';
  const onTasks = route.name === 'tasks' || route.name === 'task';
  return (
    <aside className="lx-side" aria-label="Sidebar">
      <div className="lx-ws">
        <span className="lx-logo">
          <LogoIcon />
        </span>
        Orstra
      </div>
      <NavLink to={href.cos} on={route.name === 'cos'} icon={<CosIcon />} label="Assistant" />
      <NavLink to={needsCount ? href.inbox : href.tasks} on={onTasks} icon={<TasksIcon />} label="Tasks" count={needsCount} />
      <NavLink to={href.workflows} on={route.name === 'workflows'} icon={<WorkflowsIcon />} label="Workflows" />

      {running.length > 0 && (
        <>
          <div className="lx-group">Running now</div>
          {running.map((t) => (
            <a key={t.id} className="lx-live" href={href.chat(t.id)} title={t.title}>
              <span className="lx-pulse" aria-hidden="true" />
              <span>
                {taskLabel(t)} {t.title}
              </span>
            </a>
          ))}
        </>
      )}

      <div className="lx-foot">
        <NavLink to={href.settings} on={route.name === 'settings'} icon={<SettingsIcon />} label="Settings" />
        <div className="lx-status" aria-label="Status">
          <div className="lx-status-h">
            <span className="lx-status-dot" style={{ background: connected ? 'var(--green)' : 'var(--dim)', boxShadow: connected ? '0 0 0 3px var(--green-soft)' : 'none' }} />
            <span>{connected ? 'Daemon connected' : 'Connecting to the daemon…'}</span>
            <button
              type="button"
              className="lx-theme"
              aria-label={dark ? 'Switch to light appearance' : 'Switch to dark appearance'}
              title={dark ? 'Switch to light appearance' : 'Switch to dark appearance'}
              onClick={() => setThemeChoice(dark ? 'light' : 'dark')}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d={dark ? SUN : MOON} />
              </svg>
            </button>
          </div>
          <a className="lx-stat" href={href.inbox}>
            <i style={{ background: 'var(--purple-fg)' }} />
            <span>Needs you</span>
            <b>{needsCount}</b>
          </a>
          <a className="lx-stat" href={href.tasks}>
            <i style={{ background: 'var(--accent)' }} />
            <span>Running</span>
            <b>{running.length}</b>
          </a>
          <a className="lx-stat" href={href.tasks}>
            <i style={{ background: 'var(--dim)' }} />
            <span>Queued</span>
            <b>{queuedCount}</b>
          </a>
          <a className="lx-stat" href={href.settingsGroup('usage')}>
            <i style={{ background: 'transparent' }} />
            <span>Cost today</span>
            <b>{costToday === null ? '—' : `$${costToday.toFixed(2)}`}</b>
          </a>
        </div>
      </div>
    </aside>
  );
}
