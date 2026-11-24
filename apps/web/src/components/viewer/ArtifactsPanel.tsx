import { useCallback, useMemo } from 'react';
import { api } from '../../api';
import { findRefs, refTab } from '../../lib/refs';
import { useLiveResource } from '../../lib/live';
import { ago } from '../../lib/time';
import { Svg } from './bits';
import { IC } from './tabs';
import type { PanelProps } from './Viewer';

type Item = { tab: string; title: string; kind: 'artifact' | 'image' | 'md' | 'file'; where: string; ts: number | null };

const KIND_LABEL = { artifact: 'Claude artifact', image: 'Image', md: 'Markdown', file: 'File' };
const ARTIFACT_DIR = '.orstra/artifacts/';

/**
 * What the task's agents made, newest first: the Claude artifacts and the files their messages name,
 * and the files under .orstra/artifacts/. A click opens one in a tab.
 */
export function ArtifactsPanel({ task, dispatch }: PanelProps) {
  const files = useLiveResource(`files:${task.id}`, useCallback(() => api.files(task.id), [task.id]), (id) => id === task.id, 1500);
  const items = useMemo(() => {
    const steps = new Map(task.runs.map((r) => [r.id, r.stepTitle]));
    const out = new Map<string, Item>();
    for (const e of [...task.events].reverse()) {
      if (e.kind !== 'message') continue;
      for (const r of findRefs(e.text)) {
        if (r.kind !== 'artifact' && r.kind !== 'image' && r.kind !== 'md') continue;
        const tab = refTab(r);
        if (!out.has(tab)) out.set(tab, { tab, title: r.kind === 'artifact' ? r.label : r.label, kind: r.kind, where: (e.runId && steps.get(e.runId)) || 'Chat', ts: e.ts });
      }
    }
    for (const p of files.data?.paths ?? []) {
      if (!p.startsWith(ARTIFACT_DIR)) continue;
      const tab = `file:${p}`;
      if (out.has(tab)) continue;
      const kind = /\.(png|jpe?g|gif|webp|svg)$/i.test(p) ? 'image' : /\.(md|markdown)$/i.test(p) ? 'md' : 'file';
      out.set(tab, { tab, title: p.split('/').pop() ?? p, kind, where: p.slice(ARTIFACT_DIR.length).split('/')[0] || 'artifacts', ts: null });
    }
    return [...out.values()];
  }, [task.events, task.runs, files.data]);

  return (
    <div className="vw-scroll vw-arts">
      <div className="vw-fhint">What this task’s agents made, newest first.</div>
      {items.map((it) => (
        <button key={it.tab} type="button" className="vw-art" onClick={() => dispatch({ type: 'open', tab: it.tab })} title={it.tab.replace(/^(file|link):/, '')}>
          <span className={`vw-arti vw-arti-${it.kind}`}>{it.kind === 'artifact' ? <Svg d={IC.artifact} size={15} /> : it.kind === 'md' ? 'MD' : it.kind === 'image' ? 'IMG' : <Svg d={IC.file} size={14} />}</span>
          <span className="vw-artt">
            <b>{it.title}</b>
            <span>
              {KIND_LABEL[it.kind]} · {it.where}
              {it.ts ? ` · ${ago(it.ts)}` : ''}
            </span>
          </span>
        </button>
      ))}
      {items.length === 0 && <div className="vw-empty">Nothing yet. Artifacts, pictures and documents the agents name show here.</div>}
    </div>
  );
}
