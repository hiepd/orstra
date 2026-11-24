import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { api, errorMessage, terminalStreamUrl, type TerminalInfo } from '../../api';
import { insertIntoDraft } from '../Composer';
import { shortPath } from '../GitPanel';
import { useToast } from '../Overlay';
import { serialQueue } from '../../lib/serial';
import type { PanelProps } from './Viewer';

const LAST_LINES = 40;

/** The last lines on the screen, without empty lines at either end. */
function lastLines(term: Terminal, n: number): string {
  const buf = term.buffer.active;
  const lines: string[] = [];
  for (let i = Math.max(0, buf.length - n * 3); i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? '');
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const last = lines.slice(-n);
  while (last.length && !last[0].trim()) last.shift();
  return last.join('\n');
}

/**
 * A shell in the task's worktree, on a real pty in the daemon. Output streams in as Server-Sent
 * Events; keys go out in small batches. The shell keeps running when you close the tab, and the
 * screen comes back when you open it again.
 */
export function TerminalPanel({ task }: PanelProps) {
  const toast = useToast();
  const box = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const [list, setList] = useState<TerminalInfo[]>([]);
  const [tid, setTid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ended, setEnded] = useState(false);

  const open = async () => {
    setError(null);
    try {
      const t = await api.openTerminal(task.id);
      setList((l) => [...l, t]);
      setEnded(false);
      setTid(t.id);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  // The task's first live shell, or a new one.
  useEffect(() => {
    if (!task.worktree) return;
    let gone = false;
    api
      .terminals(task.id)
      .then((ts) => {
        if (gone) return;
        setList(ts);
        if (ts[0]) setTid(ts[0].id);
        else void open();
      })
      .catch((err) => !gone && setError(errorMessage(err)));
    return () => {
      gone = true;
    };
  }, [task.id, task.worktree]);

  useEffect(() => {
    if (!tid || !box.current) return;
    const term = new Terminal({
      fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace",
      fontSize: 12.5,
      lineHeight: 1.25,
      cursorBlink: true,
      scrollback: 5000,
      theme: { background: '#161618', foreground: '#e5e5ea', cursor: '#e5e5ea', selectionBackground: 'rgba(37,99,235,0.45)' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(box.current);
    termRef.current = term;

    let pending = '';
    let timer: number | undefined;
    // One POST after the other: 2 in flight on 2 connections could reach the shell out of order.
    const send = serialQueue();
    const flush = () => {
      timer = undefined;
      const data = pending;
      pending = '';
      if (data) void send(() => api.terminalInput(tid, data));
    };
    const onData = term.onData((d) => {
      pending += d;
      timer ??= window.setTimeout(flush, 16);
    });

    let resizeTimer: number | undefined;
    const resize = () => {
      try {
        fit.fit();
      } catch {
        return;
      }
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => void api.terminalResize(tid, term.cols, term.rows).catch(() => {}), 120);
    };
    const ro = new ResizeObserver(resize);
    ro.observe(box.current);
    resize();

    const es = new EventSource(terminalStreamUrl(tid));
    es.onmessage = (m: MessageEvent<string>) => {
      try {
        const e = JSON.parse(m.data) as { type: 'data'; data: string } | { type: 'exit'; code: number };
        if (e.type === 'data') term.write(e.data);
        else {
          setEnded(true);
          es.close();
        }
      } catch {
        /* a broken line: skip it */
      }
    };
    es.onerror = () => {
      // The daemon restarted or the shell is gone. EventSource retries; a 404 means the shell ended.
      if (es.readyState === EventSource.CLOSED) setEnded(true);
    };
    term.focus();

    return () => {
      es.close();
      ro.disconnect();
      onData.dispose();
      if (timer) flush();
      window.clearTimeout(resizeTimer);
      term.dispose();
      termRef.current = null;
    };
  }, [tid]);

  const sendToChat = () => {
    const term = termRef.current;
    if (!term) return;
    const text = term.getSelection().trim() || lastLines(term, LAST_LINES);
    if (!text) return toast('The terminal shows nothing to send yet.');
    const block = '```\n' + text + '\n```';
    if (insertIntoDraft({ kind: 'task', taskId: task.id }, block)) return toast('The output is in your message. Edit it, then send it.');
    navigator.clipboard.writeText(block).then(
      () => toast('The chat has no message box now, so the output is on your clipboard.'),
      () => toast('The chat has no message box now. Reopen the session, then send it again.', { error: true }),
    );
  };

  if (!task.worktree) return <div className="vw-empty">This task has no worktree yet, so a terminal has nowhere to start.</div>;

  return (
    <>
      <div className="vw-tool">
        {list.length > 1 ? (
          <select className="vw-select" aria-label="Terminal" value={tid ?? ''} onChange={(e) => (setEnded(false), setTid(e.target.value))}>
            {list.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
              </option>
            ))}
          </select>
        ) : null}
        <span className="vw-where" title={task.worktree}>
          <span>{shortPath(task.worktree)}</span>
        </span>
        <button type="button" className="vw-btn" onClick={sendToChat} title="The selection, or the last 40 lines">
          Send to chat
        </button>
        <button type="button" className="vw-btn" onClick={() => void open()}>
          New terminal
        </button>
      </div>
      <div className="vw-term">
        {error && <div className="vw-empty">{error}</div>}
        {ended && (
          <div className="vw-termend">
            The shell ended.
            <button type="button" className="vw-btn" onClick={() => void open()}>
              Start again
            </button>
          </div>
        )}
        <div ref={box} className="vw-xterm" />
      </div>
    </>
  );
}
