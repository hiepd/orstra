import { useEffect, useState } from 'react';

export type TaskViewName = 'overview' | 'chat';

export type Route =
  | { name: 'inbox' }
  | { name: 'tasks' }
  | { name: 'task'; id: string; view: TaskViewName; runId?: string }
  | { name: 'workflows'; file?: string }
  | { name: 'settings' }
  | { name: 'notFound'; path: string };

export function parseHash(hash: string): Route {
  const path = hash.replace(/^#/, '') || '/inbox';
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  if (parts.length === 0) return { name: 'inbox' };
  // "sessions" was a page in an earlier version; a task's sessions now live on its Chat view.
  if ((parts[0] === 'inbox' || parts[0] === 'sessions') && parts.length === 1) return { name: 'inbox' };
  if (parts[0] === 'tasks') {
    if (parts.length === 1) return { name: 'tasks' };
    if (parts.length === 2) return { name: 'task', id: parts[1], view: 'overview' };
    if (parts[2] === 'chat' && parts.length <= 4) return { name: 'task', id: parts[1], view: 'chat', runId: parts[3] };
  }
  if (parts[0] === 'workflows' && parts.length <= 2) return { name: 'workflows', file: parts[1] };
  if (parts[0] === 'settings' && parts.length === 1) return { name: 'settings' };
  return { name: 'notFound', path };
}

export const href = {
  inbox: '#/inbox',
  tasks: '#/tasks',
  task: (id: string) => `#/tasks/${encodeURIComponent(id)}`,
  chat: (id: string, runId?: string) => `#/tasks/${encodeURIComponent(id)}/chat${runId ? `/${encodeURIComponent(runId)}` : ''}`,
  workflows: '#/workflows',
  workflow: (file: string) => `#/workflows/${encodeURIComponent(file)}`,
  settings: '#/settings',
};

export function navigate(to: string) {
  window.location.hash = to.replace(/^#/, '');
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));
  useEffect(() => {
    if (!window.location.hash) window.history.replaceState(null, '', href.inbox);
    const onChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', onChange);
    onChange();
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}
