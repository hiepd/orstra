import { useEffect, useState } from 'react';
import { api } from './api';
import { NewTaskModal } from './components/NewTaskModal';
import { ToastProvider } from './components/Overlay';
import { Sidebar } from './components/Sidebar';
import { handleEscape } from './lib/escape';
import { useLiveConnected, useLiveResource } from './lib/live';
import { href, useRoute } from './lib/router';
import { STATE, taskState } from './lib/taskState';
import { InboxPage } from './pages/Inbox';
import { SettingsPage } from './pages/Settings';
import { TaskPage } from './pages/TaskPage';
import { TasksPage } from './pages/Tasks';
import { WorkflowsPage } from './pages/Workflows';

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
  const [newTask, setNewTask] = useState(false);
  const tasks = useLiveResource('nav:tasks', api.tasks);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      handleEscape(e);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const count = (group: string) => tasks.data?.filter((t) => STATE[taskState(t)].group === group).length ?? 0;
  const inboxCount = count('needs');
  const openNew = () => setNewTask(true);

  useEffect(() => {
    document.title = inboxCount ? `(${inboxCount}) Orstra` : 'Orstra';
  }, [inboxCount]);

  return (
    <div className="lx">
      <Sidebar route={route} inboxCount={inboxCount} runningCount={count('running')} queuedCount={count('queued')} connected={connected} />
      <div className="lx-frame">
        {route.name === 'inbox' && <InboxPage />}
        {route.name === 'tasks' && <TasksPage onNewTask={openNew} />}
        {route.name === 'task' && <TaskPage key={route.id} id={route.id} view={route.view} runId={route.runId} />}
        {route.name === 'workflows' && <WorkflowsPage file={route.file} />}
        {route.name === 'settings' && <SettingsPage />}
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
      {newTask && <NewTaskModal onClose={() => setNewTask(false)} />}
    </div>
  );
}
