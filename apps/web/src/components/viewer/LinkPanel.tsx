import { useCallback, useState } from 'react';
import { api } from '../../api';
import { useLiveResource } from '../../lib/live';
import { Svg, Tool } from './bits';
import { IC, tabMeta } from './tabs';
import type { PanelProps } from './Viewer';

/**
 * A web link or a Claude artifact. The daemon checks first whether the site lets other pages frame
 * it: if so, the page shows in a sandboxed frame; if not, a card with its title and a button to open
 * it. A local URL (the dev server) always shows in the frame.
 */
export function LinkPanel({ tab }: PanelProps) {
  const url = tab.slice('link:'.length);
  const meta = tabMeta(tab);
  const local = meta.kind === 'local';
  const [n, setN] = useState(0);
  const info = useLiveResource(`link:${url}`, useCallback(() => (local ? Promise.resolve({ url, frameable: true, title: null }) : api.linkInfo(url)), [url, local]), () => false);
  const openLabel = meta.kind === 'artifact' ? 'Open in claude.ai' : 'Open in browser';

  return (
    <>
      <Tool
        where={url}
        before={
          <button type="button" className="lx-ib vw-ib" aria-label="Reload" title="Reload" onClick={() => setN((x) => x + 1)}>
            <Svg d={IC.reload} size={14} sw={2} />
          </button>
        }
      >
        <a className="vw-btn" href={url} target="_blank" rel="noopener noreferrer">
          {openLabel}
        </a>
      </Tool>
      <div className="vw-scroll vw-frame">
        {info.data === undefined && !info.error && <div className="vw-empty">Loading…</div>}
        {info.data?.frameable && (
          <iframe
            key={n}
            src={url}
            title={info.data.title ?? meta.title}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
            referrerPolicy="no-referrer"
          />
        )}
        {(info.error || (info.data && !info.data.frameable)) && (
          <div className="vw-card">
            <span className={meta.kind === 'artifact' ? 'vw-cardi vw-cardi-art' : 'vw-cardi'}>
              <Svg d={meta.icon} size={18} />
            </span>
            <b>{info.data?.title ?? (meta.kind === 'artifact' ? 'Claude artifact' : meta.label)}</b>
            <span className="vw-cardu">{url}</span>
            <span className="vw-cardn">{meta.kind === 'artifact' ? 'claude.ai does not show inside another page. Open it there; it stays private to you.' : 'This site does not show inside another page.'}</span>
            <a className="lx-btn lx-pri" href={url} target="_blank" rel="noopener noreferrer">
              {openLabel}
            </a>
          </div>
        )}
      </div>
    </>
  );
}
