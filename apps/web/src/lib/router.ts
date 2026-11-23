import { useEffect, useState } from 'react';

export type TaskViewName = 'overview' | 'chat';

export type Route =
  | { name: 'cos' }
  | { name: 'inbox' }
  | { name: 'tasks' }
  | { name: 'task'; id: string; view: TaskViewName; runId?: string }
  | { name: 'workflows'; file?: string }
  | { name: 'settings'; group?: string }
  | { name: 'notFound'; path: string };

export function parseHash(hash: string): Route {
  const path = hash.replace(/^#/, '') || '/';
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  if (parts.length === 0) return { name: 'cos' };
  // "sessions" was a page in an earlier version; a task's sessions now live on its Chat view.
  if ((parts[0] === 'inbox' || parts[0] === 'sessions') && parts.length === 1) return { name: 'inbox' };
  if (parts[0] === 'tasks') {
    if (parts.length === 1) return { name: 'tasks' };
    if (parts.length === 2) return { name: 'task', id: parts[1], view: 'overview' };
    if (parts[2] === 'chat' && parts.length <= 4) return { name: 'task', id: parts[1], view: 'chat', runId: parts[3] };
  }
  if (parts[0] === 'workflows' && parts.length <= 2) return { name: 'workflows', file: parts[1] };
  // "#/settings" is the whole page; "#/settings/<group>" deep-links one group.
  if (parts[0] === 'settings' && parts.length <= 2) return { name: 'settings', group: parts[1] };
  return { name: 'notFound', path };
}

export const href = {
  cos: '#/',
  inbox: '#/inbox',
  tasks: '#/tasks',
  task: (id: string) => `#/tasks/${encodeURIComponent(id)}`,
  chat: (id: string, runId?: string) => `#/tasks/${encodeURIComponent(id)}/chat${runId ? `/${encodeURIComponent(runId)}` : ''}`,
  workflows: '#/workflows',
  workflow: (file: string) => `#/workflows/${encodeURIComponent(file)}`,
  settings: '#/settings',
  settingsGroup: (id: string) => `#/settings/${encodeURIComponent(id)}`,
};

export function navigate(to: string) {
  window.location.hash = to.replace(/^#/, '');
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));
  useEffect(() => {
    if (!window.location.hash) window.history.replaceState(null, '', href.cos);
    const onChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', onChange);
    onChange();
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}
