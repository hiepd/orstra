import { useEffect, useState } from 'react';
import { api } from './api';
import { NewTaskModal } from './components/NewTaskModal';
import { ToastProvider } from './components/Overlay';
import { Sidebar } from './components/Sidebar';
import { handleEscape } from './lib/escape';
import { useLiveConnected, useLiveResource } from './lib/live';
import { href, useRoute } from './lib/router';
import { InboxPage } from './pages/Inbox';
import { SessionsPage } from './pages/Sessions';
import { TaskPage } from './pages/TaskPage';
import { TasksPage } from './pages/Tasks';

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
  const sessions = useLiveResource('nav:sessions', api.sessions);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      handleEscape(e);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const inboxCount = tasks.data?.filter((t) => t.status === 'needs_you').length ?? 0;
  const runningCount = sessions.data?.filter((s) => s.status === 'running').length ?? 0;
  const queuedCount = sessions.data?.filter((s) => s.status === 'queued').length ?? 0;
  const openNew = () => setNewTask(true);

  useEffect(() => {
    document.title = inboxCount ? `(${inboxCount}) Orstra` : 'Orstra';
  }, [inboxCount]);

  return (
    <div className="lx">
      <Sidebar route={route} inboxCount={inboxCount} runningCount={runningCount} queuedCount={queuedCount} connected={connected} onNewTask={openNew} />
      <div className="lx-frame">
        {route.name === 'sessions' && <SessionsPage onNewTask={openNew} />}
        {route.name === 'inbox' && <InboxPage />}
        {route.name === 'tasks' && <TasksPage onNewTask={openNew} />}
        {route.name === 'task' && <TaskPage key={route.id} id={route.id} />}
        {route.name === 'notFound' && (
          <div className="lx-empty">
            <b>Nothing here</b>
            <span>
              No page at <code className="lx-mono">{route.path}</code>.
            </span>
            <a className="lx-btn" href={href.sessions}>
              Go to Sessions
            </a>
          </div>
        )}
      </div>
      {newTask && <NewTaskModal onClose={() => setNewTask(false)} />}
    </div>
  );
}
