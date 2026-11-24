import type { TabId } from './state';

/** Icon paths (24 × 24, stroked) for the viewer's tabs and menus. */
export const IC = {
  changes: 'M5 4h14v16H5zM12 8v8M8 12h8',
  files: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  browser: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18',
  terminal: 'M5 8l4 4-4 4M12 16h7',
  side: 'M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z',
  artifacts: 'M8 4h11v13H8zM5 7v13h11',
  md: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M9 13h6M9 17h4',
  img: 'M4 5h16v14H4zM8.5 10a1.5 1.5 0 1 0 0-.01M20 16l-5-5-8 8',
  file: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  artifact: 'M4 4h16v16H4zM8 9h8M8 13h8M8 17h5',
  splitRight: 'M4 5h16v14H4zM12 5v14',
  splitDown: 'M4 5h16v14H4zM4 12h16',
  unsplit: 'M4 5h16v14H4zM9 9l6 6M15 9l-6 6',
  close: 'M6 6l12 12M18 6 6 18',
  plus: 'M12 5v14M5 12h14',
  expand: 'M15 4h5v5M9 20H4v-5M20 4l-6 6M4 20l6-6',
  collapse: 'M9 4v5H4M15 20v-5h5M20 4l-5 5M4 20l5-5',
  back: 'M15 6l-6 6 6 6',
  reload: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
  viewer: 'M3 4h18v16H3zM14 4v16',
};

/** The panels the + menu opens, in its order, with their shortcuts. */
export const PANELS = [
  { id: 'changes', label: 'Changes', kbd: '⇧⌘D' },
  { id: 'browser', label: 'Browser', kbd: '⇧⌘B' },
  { id: 'files', label: 'Files', kbd: '⇧⌘F' },
  { id: 'terminal', label: 'Terminal', kbd: '⌘J' },
  { id: 'side', label: 'Side chat', kbd: '⌘;' },
  { id: 'artifacts', label: 'Artifacts', kbd: '' },
] as const;

export type TabKind = 'changes' | 'files' | 'browser' | 'terminal' | 'side' | 'artifacts' | 'md' | 'image' | 'text' | 'link' | 'artifact' | 'local';

const IMAGE = /\.(png|jpe?g|gif|webp|svg)$/i;
const MD = /\.(md|markdown)$/i;

/** What a tab is, what it says, and how it looks in the tab strip. */
export function tabMeta(id: TabId): { kind: TabKind; label: string; icon: string; color: string; title: string } {
  const panel = PANELS.find((p) => p.id === id);
  if (panel) {
    const color = id === 'side' ? 'var(--accent-fg)' : id === 'artifacts' ? 'var(--claude)' : id === 'browser' ? 'var(--green-fg)' : 'var(--muted)';
    return { kind: id as TabKind, label: panel.label, icon: IC[id as keyof typeof IC], color, title: panel.label };
  }
  if (id.startsWith('file:')) {
    const path = id.slice(5);
    const name = path.split('/').pop() ?? path;
    if (MD.test(path)) return { kind: 'md', label: name, icon: IC.md, color: 'var(--accent-fg)', title: path };
    if (IMAGE.test(path)) return { kind: 'image', label: name, icon: IC.img, color: 'var(--green-fg)', title: path };
    return { kind: 'text', label: name, icon: IC.file, color: 'var(--muted)', title: path };
  }
  const url = id.startsWith('link:') ? id.slice(5) : id;
  let host = url;
  let label = url;
  try {
    const u = new URL(url);
    host = u.hostname;
    label = (u.host + u.pathname).replace(/\/$/, '');
  } catch {
    /* keep the raw text */
  }
  if (host === 'claude.ai') return { kind: 'artifact', label: 'Claude artifact', icon: IC.artifact, color: 'var(--claude)', title: url };
  if (host === 'localhost' || host === '127.0.0.1') return { kind: 'local', label, icon: IC.browser, color: 'var(--green-fg)', title: url };
  return { kind: 'link', label: label.length > 40 ? label.slice(0, 39) + '…' : label, icon: IC.link, color: 'var(--muted)', title: url };
}
