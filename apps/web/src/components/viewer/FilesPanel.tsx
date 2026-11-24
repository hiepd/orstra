import { useCallback, useMemo, useState } from 'react';
import { api } from '../../api';
import { useLiveResource } from '../../lib/live';
import { shortPath } from '../GitPanel';
import { ChevronRight } from '../Icons';
import type { PanelProps } from './Viewer';

type Dir = { name: string; path: string; dirs: Map<string, Dir>; files: string[] };

function buildTree(paths: string[]): Dir {
  const root: Dir = { name: '', path: '', dirs: new Map(), files: [] };
  for (const p of paths) {
    const parts = p.split('/');
    let d = root;
    for (const part of parts.slice(0, -1)) {
      let next = d.dirs.get(part);
      if (!next) {
        next = { name: part, path: d.path ? `${d.path}/${part}` : part, dirs: new Map(), files: [] };
        d.dirs.set(part, next);
      }
      d = next;
    }
    d.files.push(p);
  }
  return root;
}

/** The worktree's files as a tree (what .gitignore leaves out is not there). A click opens a file in a tab. */
export function FilesPanel({ task, git, dispatch }: PanelProps) {
  const files = useLiveResource(`files:${task.id}`, useCallback(() => api.files(task.id), [task.id]), (id) => id === task.id, 1500);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [filter, setFilter] = useState('');
  const status = useMemo(() => new Map((git.data?.files ?? []).map((f) => [f.path, f.status])), [git.data]);
  const tree = useMemo(() => buildTree(files.data?.paths ?? []), [files.data]);
  const openFile = (p: string) => dispatch({ type: 'open', tab: `file:${p}` });

  const fileRow = (p: string, depth: number, label = p.split('/').pop()) => (
    <button key={p} type="button" className="vw-frow" style={{ paddingLeft: 10 + depth * 16 }} onClick={() => openFile(p)} title={p}>
      <span className="vw-fname">{label}</span>
      {status.get(p) && <span className={`ox-fs ox-fs-${status.get(p)}`}>{status.get(p)}</span>}
    </button>
  );

  const renderDir = (d: Dir, depth: number): JSX.Element[] => {
    const rows: JSX.Element[] = [];
    for (const sub of [...d.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      const isOpen = open[sub.path] ?? false;
      rows.push(
        <button key={`d:${sub.path}`} type="button" className="vw-frow vw-fdir" style={{ paddingLeft: 10 + depth * 16 }} aria-expanded={isOpen} onClick={() => setOpen((m) => ({ ...m, [sub.path]: !isOpen }))}>
          <ChevronRight open={isOpen} size={10} />
          <span className="vw-fname">{sub.name}</span>
        </button>,
      );
      if (isOpen) rows.push(...renderDir(sub, depth + 1));
    }
    for (const f of d.files) rows.push(fileRow(f, depth));
    return rows;
  };

  const q = filter.trim().toLowerCase();
  return (
    <>
      <div className="vw-tool">
        <input className="vw-filter" aria-label="Filter files" placeholder="Filter files" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      <div className="vw-scroll vw-files">
        {task.worktree && <div className="vw-fhint">{shortPath(task.worktree)} · read-only here</div>}
        {files.error && <div className="vw-empty">{files.error}</div>}
        {!files.data && !files.error && <div className="vw-empty">Loading…</div>}
        {files.data && (q ? (files.data.paths.filter((p) => p.toLowerCase().includes(q)).slice(0, 500).map((p) => fileRow(p, 0, p))) : renderDir(tree, 0))}
        {files.data?.truncated && <div className="vw-fhint">Only the first 5000 files show.</div>}
      </div>
    </>
  );
}
