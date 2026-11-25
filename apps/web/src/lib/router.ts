import { useEffect, useState } from 'react';

export type TaskViewName = 'overview' | 'chat';

export type Route =
  | { name: 'cos' }
  /** Tasks. `inbox`: the Inbox view, with `sel` the task open in its pane. */
  | { name: 'tasks'; inbox?: boolean; sel?: string; selView?: TaskViewName }
  | { name: 'task'; id: string; view: TaskViewName; runId?: string }
  | { name: 'workflows'; file?: string }
  /** Workspaces. `id`: the one open beside the list; `tab`: its Overview or Settings. */
  | { name: 'workspaces'; id?: string; tab?: 'overview' | 'settings' }
  /** What starts tasks on its own. It was a Settings group before it had its own page. */
  | { name: 'triggers' }
  | { name: 'settings'; group?: string }
  | { name: 'notFound'; path: string };

export function parseHash(hash: string): Route {
  const path = hash.replace(/^#/, '') || '/';
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  if (parts.length === 0) return { name: 'cos' };
  // "sessions" was a page in an earlier version; a task's sessions now live on its Chat view.
  if (parts[0] === 'sessions' && parts.length === 1) return { name: 'tasks', inbox: true };
  // The Inbox is the first view of Tasks: what needs you, across workflows, with the task open beside it.
  if (parts[0] === 'inbox' && parts.length <= 3 && (parts.length < 3 || parts[2] === 'chat')) {
    return { name: 'tasks', inbox: true, sel: parts[1], selView: parts[2] === 'chat' ? 'chat' : 'overview' };
  }
  if (parts[0] === 'tasks') {
    if (parts.length === 1) return { name: 'tasks' };
    if (parts.length === 2) return { name: 'task', id: parts[1], view: 'overview' };
    if (parts[2] === 'chat' && parts.length <= 4) return { name: 'task', id: parts[1], view: 'chat', runId: parts[3] };
  }
  if (parts[0] === 'workflows' && parts.length <= 2) return { name: 'workflows', file: parts[1] };
  if (parts[0] === 'workspaces' && parts.length <= 3 && (parts.length < 3 || parts[2] === 'settings')) {
    return { name: 'workspaces', id: parts[1], tab: parts[2] === 'settings' ? 'settings' : 'overview' };
  }
  if (parts[0] === 'triggers' && parts.length === 1) return { name: 'triggers' };
  // Triggers was a Settings group; an old link to it still opens the Triggers page.
  if (parts[0] === 'settings' && parts[1] === 'triggers' && parts.length === 2) return { name: 'triggers' };
  // "#/settings" is the whole page; "#/settings/<group>" deep-links one group.
  if (parts[0] === 'settings' && parts.length <= 2) return { name: 'settings', group: parts[1] };
  return { name: 'notFound', path };
}

export const href = {
  cos: '#/',
  inbox: '#/inbox',
  inboxTask: (id: string, view?: TaskViewName) => `#/inbox/${encodeURIComponent(id)}${view === 'chat' ? '/chat' : ''}`,
  tasks: '#/tasks',
  task: (id: string) => `#/tasks/${encodeURIComponent(id)}`,
  chat: (id: string, runId?: string) => `#/tasks/${encodeURIComponent(id)}/chat${runId ? `/${encodeURIComponent(runId)}` : ''}`,
  workflows: '#/workflows',
  workspaces: '#/workspaces',
  workspace: (id: string, tab?: 'overview' | 'settings') => `#/workspaces/${encodeURIComponent(id)}${tab === 'settings' ? '/settings' : ''}`,
  workflow: (file: string) => `#/workflows/${encodeURIComponent(file)}`,
  triggers: '#/triggers',
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
    const onChange = () => {
      const next = parseHash(window.location.hash);
      // An old link (#/settings/triggers) shows the page's own address, so a copied link is the new one.
      if (next.name === 'triggers' && window.location.hash !== href.triggers) window.history.replaceState(null, '', href.triggers);
      setRoute(next);
    };
    window.addEventListener('hashchange', onChange);
    onChange();
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}
