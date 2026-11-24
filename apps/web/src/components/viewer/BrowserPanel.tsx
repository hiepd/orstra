import { useCallback, useEffect, useState } from 'react';
import { api, errorMessage } from '../../api';
import { useLiveResource } from '../../lib/live';
import { useToast } from '../Overlay';
import { Svg } from './bits';
import { IC } from './tabs';
import type { PanelProps } from './Viewer';

/**
 * The task's dev server, started by Orstra in the worktree, in a frame. Before a start you see the
 * command (from package.json, and you can change it); after, its page, with Restart and Stop.
 */
export function BrowserPanel({ task }: PanelProps) {
  const toast = useToast();
  const dev = useLiveResource(`dev:${task.id}`, useCallback(() => api.devServer(task.id), [task.id]), (id) => id === task.id);
  const v = dev.data;
  const [command, setCommand] = useState('');
  const [busy, setBusy] = useState(false);
  const [path, setPath] = useState('/');
  const [n, setN] = useState(0);

  useEffect(() => {
    if (v && !command) setCommand(v.command ?? v.suggested ?? '');
  }, [v, command]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      dev.reload();
    } catch (err) {
      toast(errorMessage(err), { error: true });
    } finally {
      setBusy(false);
    }
  };
  const start = () => run(() => api.startDevServer(task.id, command.trim() || undefined));
  const stop = () => run(() => api.stopDevServer(task.id));

  if (!task.worktree) return <div className="vw-empty">This task has no worktree yet, so there is no dev server to start.</div>;
  if (dev.error && !v) return <div className="vw-empty">{dev.error}</div>;
  if (!v) return <div className="vw-empty">Loading…</div>;

  const origin = v.url ? new URL(v.url).origin : null;
  const src = origin ? origin + (path.startsWith('/') ? path : `/${path}`) : null;

  if (v.state === 'running' && src) {
    return (
      <>
        <div className="vw-tool">
          <button type="button" className="lx-ib vw-ib" aria-label="Reload" title="Reload" onClick={() => setN((x) => x + 1)}>
            <Svg d={IC.reload} size={14} sw={2} />
          </button>
          <form
            className="vw-where vw-addr"
            onSubmit={(e) => {
              e.preventDefault();
              setN((x) => x + 1);
            }}
          >
            <span className="vw-origin">{origin}</span>
            <input aria-label="Path on the dev server" value={path} onChange={(e) => setPath(e.target.value)} />
          </form>
          <a className="vw-btn" href={src} target="_blank" rel="noopener noreferrer">
            Open in browser
          </a>
        </div>
        <div className="vw-devbar">
          <span className="vw-dot" />
          <span className="vw-devcmd">
            {v.command} · port {new URL(v.url!).port}
          </span>
          <button type="button" className="vw-btn" disabled={busy} onClick={() => void start()}>
            Restart
          </button>
          <button type="button" className="vw-btn" disabled={busy} onClick={() => void stop()}>
            Stop
          </button>
        </div>
        <div className="vw-scroll vw-frame">
          <iframe key={`${src}:${n}`} src={src} title="Dev server" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals" />
        </div>
      </>
    );
  }

  return (
    <div className="vw-scroll vw-dev">
      <form
        className="vw-devform"
        onSubmit={(e) => {
          e.preventDefault();
          void start();
        }}
      >
        <label htmlFor={`dev-${task.id}`}>Command that starts the dev server</label>
        <div className="vw-devrow">
          <input id={`dev-${task.id}`} className="vw-filter lx-mono" value={command} placeholder="npm run dev" onChange={(e) => setCommand(e.target.value)} />
          <button type="submit" className="lx-btn lx-pri" disabled={busy || v.state === 'starting'}>
            {v.state === 'starting' ? 'Starting…' : v.state === 'exited' ? 'Start again' : 'Start'}
          </button>
          {v.state === 'starting' && (
            <button type="button" className="lx-btn" disabled={busy} onClick={() => void stop()}>
              Stop
            </button>
          )}
        </div>
        <span className="vw-fhint" style={{ padding: 0 }}>
          It runs in the worktree, with a free port in PORT. Orstra shows the page when the server prints its address or the port answers.
        </span>
      </form>
      {v.state === 'exited' && <div className="vw-devexit">The command ended with code {v.exitCode ?? '?'}.</div>}
      {v.log && <pre className="ox-pre vw-devlog">{v.log}</pre>}
    </div>
  );
}
