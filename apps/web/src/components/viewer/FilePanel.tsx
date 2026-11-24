import { useCallback, useState } from 'react';
import { worktreeFileUrl } from '../../api';
import { useLiveResource } from '../../lib/live';
import { Markdown } from '../Markdown';
import { useToast } from '../Overlay';
import { Seg, Tool } from './bits';
import { tabMeta } from './tabs';
import type { PanelProps } from './Viewer';

const MAX_LINES = 5000;

async function readText(url: string): Promise<string> {
  const r = await fetch(url, { cache: 'no-store' });
  if (r.status === 404) {
    const body = (await r.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? 'This file is not in the worktree now.');
  }
  if (!r.ok) throw new Error(`The daemon answered ${r.status}.`);
  return r.text();
}

/**
 * One worktree file: markdown (Rendered or Source), a picture (Fit or 100%), other text with line
 * numbers. It reads the file again when the task changes, since the agent may edit it.
 */
export function FilePanel({ task, tab }: PanelProps) {
  const toast = useToast();
  const path = tab.slice('file:'.length);
  const kind = tabMeta(tab).kind;
  const url = worktreeFileUrl(task.id, path);
  const [source, setSource] = useState(false);
  const [full, setFull] = useState(false);
  const [stamp, setStamp] = useState(0);
  const [broken, setBroken] = useState(-1);
  const text = useLiveResource(
    `file:${task.id}:${path}`,
    useCallback(() => (kind === 'image' ? (setStamp((n) => n + 1), Promise.resolve('')) : readText(url)), [kind, url]),
    (id) => id === task.id,
    1500,
  );

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(path);
      toast('Path copied');
    } catch {
      toast('Couldn’t copy to the clipboard', { error: true });
    }
  };

  const body = (() => {
    if (text.error) return <div className="vw-empty">{text.error}</div>;
    // Each refetch (stamp) tries the picture again: the agent may write it later.
    if (kind === 'image' && broken === stamp) return <div className="vw-empty">This file is not in the task’s worktree, or in a repository its agent worked in.</div>;
    if (kind === 'image')
      return (
        <div className="vw-img">
          <img className={full ? 'vw-img-full' : 'vw-img-fit'} src={`${url}&v=${stamp}`} alt={path} onError={() => setBroken(stamp)} />
        </div>
      );
    if (text.data === undefined) return <div className="vw-empty">Loading…</div>;
    if (kind === 'md' && !source)
      return (
        <article className="vw-md">
          <Markdown text={text.data} />
        </article>
      );
    if (text.data.slice(0, 8000).includes('\0'))
      return (
        <div className="vw-empty">
          <span>
            This file is not text. <a href={url} target="_blank" rel="noreferrer">Open it in a new tab</a>.
          </span>
        </div>
      );
    const lines = text.data.split('\n');
    return (
      <div className="vw-code">
        {lines.slice(0, MAX_LINES).map((l, i) => (
          <div key={i} className="vw-line">
            <span className="vw-ln">{i + 1}</span>
            <span>{l || ' '}</span>
          </div>
        ))}
        {lines.length > MAX_LINES && <div className="vw-empty">Only the first {MAX_LINES} lines show.</div>}
      </div>
    );
  })();

  return (
    <>
      <Tool where={path}>
        {kind === 'md' && <Seg label="Markdown view" value={source ? 'source' : 'rendered'} options={[{ id: 'rendered', label: 'Rendered' }, { id: 'source', label: 'Source' }]} onChange={(v) => setSource(v === 'source')} />}
        {kind === 'image' && <Seg label="Zoom" value={full ? 'full' : 'fit'} options={[{ id: 'fit', label: 'Fit' }, { id: 'full', label: '100%' }]} onChange={(v) => setFull(v === 'full')} />}
        <button type="button" className="vw-btn" onClick={() => void copy()}>
          Copy path
        </button>
      </Tool>
      <div className="vw-scroll">{body}</div>
    </>
  );
}
