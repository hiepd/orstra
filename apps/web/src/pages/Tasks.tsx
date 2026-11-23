import { useState } from 'react';
import { api, type TaskSummary } from '../api';
import { ChevronRight, PlusIcon, TasksIcon } from '../components/Icons';
import { TaskStatusIcon } from '../components/Status';
import { reasonText, taskLabel } from '../lib/format';
import { useLiveResource, useNow } from '../lib/live';
import { href } from '../lib/router';
import { age } from '../lib/time';

const GROUPS: { status: TaskSummary['status']; name: string }[] = [
  { status: 'needs_you', name: 'Needs you' },
  { status: 'running', name: 'Running' },
  { status: 'done', name: 'Done' },
  { status: 'stopped', name: 'Stopped' },
];

export function TasksPage({ onNewTask }: { onNewTask: () => void }) {
  const now = useNow(30_000);
  const res = useLiveResource('tasks', api.tasks);
  const [collapsed, setCollapsed] = useState<Partial<Record<TaskSummary['status'], boolean>>>({});
  const tasks = res.data ?? [];

  return (
    <>
      <div className="lx-bar">
        <span className="lx-crumb">
          <b>Tasks</b>
        </span>
        {res.data && <span className="lx-muted">{tasks.length} total</span>}
        <div className="lx-acts">
          <button className="lx-btn" onClick={onNewTask}>
            <PlusIcon />
            New task
          </button>
        </div>
      </div>
      <div className="lx-body">
        {res.error && !res.data && <div className="lx-error">{res.error}</div>}
        {res.loading && !res.data && !res.error && (
          <div className="lx-loading">
            <span className="lx-spin" /> Loading tasks…
          </div>
        )}
        {res.data && tasks.length === 0 && (
          <div className="lx-empty">
            <span style={{ color: '#B4B5BD' }}>
              <TasksIcon />
            </span>
            <b>No tasks yet</b>
            <span>A task is one thing moving through a workflow, like a Linear ticket.</span>
            <button className="lx-btn lx-pri" onClick={onNewTask}>
              <PlusIcon />
              New task
            </button>
          </div>
        )}
        {GROUPS.map((g) => {
          const rows = tasks.filter((t) => t.status === g.status);
          if (rows.length === 0) return null;
          const open = !collapsed[g.status];
          return (
            <div key={g.status}>
              <button className="lx-gh" onClick={() => setCollapsed((c) => ({ ...c, [g.status]: open }))} aria-expanded={open}>
                <ChevronRight open={open} />
                {g.name}
                <span>{rows.length}</span>
              </button>
              {open &&
                rows.map((t) => (
                  <a
                    key={t.id}
                    className="lx-trow"
                    href={href.task(t.id)}
                    style={{ color: 'inherit', textDecoration: 'none' }}
                  >
                    <TaskStatusIcon task={t} />
                    <span className="lx-id">{taskLabel(t)}</span>
                    <span className="lx-ttl">{t.title}</span>
                    <span className="lx-now" style={{ color: '#6F6F78' }}>
                      {t.status === 'needs_you' ? reasonText(t.inboxReason) : t.currentStepTitle ?? ''}
                    </span>
                    <span className="lx-muted" style={{ whiteSpace: 'nowrap' }}>
                      {t.workflow}
                    </span>
                    <span className="lx-time">{age(t.updatedAt, now)}</span>
                  </a>
                ))}
            </div>
          );
        })}
      </div>
    </>
  );
}
