import { useEffect, useState } from 'react';

export type Route =
  | { name: 'inbox' }
  | { name: 'sessions' }
  | { name: 'tasks' }
  | { name: 'task'; id: string }
  | { name: 'notFound'; path: string };

export function parseHash(hash: string): Route {
  const path = hash.replace(/^#/, '') || '/sessions';
  const parts = path.split('/').filter(Boolean);
  if (parts.length === 0) return { name: 'sessions' };
  if (parts[0] === 'inbox' && parts.length === 1) return { name: 'inbox' };
  if (parts[0] === 'sessions' && parts.length === 1) return { name: 'sessions' };
  if (parts[0] === 'tasks' && parts.length === 1) return { name: 'tasks' };
  if (parts[0] === 'tasks' && parts.length === 2) return { name: 'task', id: decodeURIComponent(parts[1]) };
  return { name: 'notFound', path };
}

export const href = {
  inbox: '#/inbox',
  sessions: '#/sessions',
  tasks: '#/tasks',
  task: (id: string) => `#/tasks/${encodeURIComponent(id)}`,
};

export function navigate(to: string) {
  window.location.hash = to.replace(/^#/, '');
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));
  useEffect(() => {
    if (!window.location.hash) window.history.replaceState(null, '', href.sessions);
    const onChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', onChange);
    onChange();
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}
