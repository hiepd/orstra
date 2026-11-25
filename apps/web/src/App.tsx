import { useEffect, useState } from 'react';
import { api } from './api';
import { NewTaskModal } from './components/NewTaskModal';
import { ToastProvider } from './components/Overlay';
import { Sidebar } from './components/Sidebar';
import { handleEscape } from './lib/escape';
import { useLiveConnected, useLiveResource } from './lib/live';
import { href, useRoute } from './lib/router';
import { STATE, taskState } from './lib/taskState';
import { CosPage } from './pages/Cos';
import { SettingsPage } from './pages/Settings';
import { TaskPage } from './pages/TaskPage';
import { TasksPage } from './pages/Tasks';
import { TriggersPage } from './pages/Triggers';
import { WorkflowsPage } from './pages/Workflows';
import { WorkspacesPage } from './pages/Workspaces';

export function App() {
  return (
    <ToastProvider>
      <Shell />
    </ToastProvider>
  );
}

function Shell() {
  const route = useRoute();
  const connected = useLiveConnected();
  // The New task form, open or not. `workspace` preselects one, as "New task in <workspace>" does.
  const [newTask, setNewTask] = useState<{ workspace?: string } | null>(null);
  // Counts and the running list, for the sidebar. A working agent changes its task many times a
  // second; the sidebar reads none of that, so it refetches far less often than the chat does.
  const tasks = useLiveResource('nav:tasks', api.tasks, undefined, 1000);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      handleEscape(e);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const count = (group: string) => tasks.data?.filter((t) => STATE[taskState(t)].group === group).length ?? 0;
  const inboxCount = count('needs');
  const running = tasks.data?.filter((t) => taskState(t) === 'working') ?? [];
  // Cost changes when a run ends a turn; a slow refresh is enough for the sidebar.
  const settings = useLiveResource('nav:settings', api.settings, undefined, 5000);
  const openNew = (workspace?: string) => setNewTask({ workspace });

  useEffect(() => {
    document.title = inboxCount ? `(${inboxCount}) Orstra` : 'Orstra';
  }, [inboxCount]);

  return (
    <div className="lx">
      <Sidebar route={route} needsCount={inboxCount} running={running} queuedCount={count('queued')} costToday={settings.data?.cost?.today ?? null} connected={connected} />
      <div className="lx-frame">
        {route.name === 'cos' && <CosPage />}
        {route.name === 'tasks' && <TasksPage onNewTask={() => openNew()} inbox={!!route.inbox} sel={route.sel} selView={route.selView} />}
        {route.name === 'task' && <TaskPage key={route.id} id={route.id} view={route.view} runId={route.runId} />}
        {route.name === 'workspaces' && <WorkspacesPage id={route.id} tab={route.tab ?? 'overview'} onNewTask={openNew} />}
        {route.name === 'workflows' && <WorkflowsPage file={route.file} />}
        {route.name === 'triggers' && <TriggersPage />}
        {route.name === 'settings' &&<SettingsPage group={route.group} />}
        {route.name === 'notFound' && (
          <div className="lx-empty">
            <b>Nothing here</b>
            <span>
              No page at <code className="lx-mono">{route.path}</code>.
            </span>
            <a className="lx-btn" href={href.inbox}>
              Go to Inbox
            </a>
          </div>
        )}
      </div>
      {newTask && <NewTaskModal workspace={newTask.workspace} onClose={() => setNewTask(null)} />}
    </div>
  );
}
