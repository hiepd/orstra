import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react';
import { api, errorMessage, fileUrl, type ChatFile } from '../api';
import { filesOf, humanBytes, isImage, upload } from '../lib/attach';
import { useToast } from './Overlay';

/** The files on the draft: name, size, and a thumbnail for a picture. A click removes one. */
function Chips({ taskId, files, onRemove }: { taskId: string; files: ChatFile[]; onRemove: (path: string) => void }) {
  if (!files.length) return null;
  return (
    <div className="ox-chips">
      {files.map((f) => (
        <span key={f.path} className="ox-chip" title={`${f.name} · ${f.path}`}>
          {isImage(f.mime) ? <img className="ox-chipt" src={fileUrl(taskId, f.path)} alt="" /> : <span className="ox-chipt ox-chipe">{(f.name.split('.').pop() ?? 'file').slice(0, 4).toUpperCase()}</span>}
          <span className="ox-chipn">{f.name}</span>
          <span className="ox-chipb">{humanBytes(f.bytes)}</span>
          <button className="ox-chipr" aria-label={`Remove ${f.name}`} onClick={() => onRemove(f.path)}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </span>
      ))}
    </div>
  );
}

/**
 * The message box for one session. Enter sends. While the agent is working and the box is empty,
 * the button stops its current turn; the session stays open for your next message.
 *
 * You add a file in 3 ways: paste it, drop it on the box, or pick it. Orstra writes it into the
 * task's worktree and puts its path at the end of your message, so the agent can open it.
 */
export function ChatBox({
  taskId,
  runId,
  working,
  canStop,
  waiting,
  reopened,
  who,
  av,
  color,
  branch,
}: {
  taskId: string;
  runId: string;
  /** The agent is in the middle of a turn. */
  working: boolean;
  /** Stop is offered only for the run the task is on. */
  canStop: boolean;
  /** The agent is waiting for your reply. */
  waiting: boolean;
  /** An ended session you reopened: talking here doesn't move the task. */
  reopened: boolean;
  who: string;
  av: string;
  color: string;
  branch: string | null;
}) {
  const toast = useToast();
  const [draft, setDraft] = useState('');
  const [files, setFiles] = useState<ChatFile[]>([]);
  const [busy, setBusy] = useState(false);
  /** A file is on its way to the worktree. */
  const [adding, setAdding] = useState(false);
  const [over, setOver] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (waiting) ref.current?.focus();
  }, [waiting]);

  const add = async (picked: File[]) => {
    if (!picked.length) return;
    setAdding(true);
    try {
      const res = await upload(taskId, picked, files);
      if (res.added.length) setFiles((f) => [...f, ...res.added]);
      for (const e of res.errors) toast(e, { error: true });
    } finally {
      setAdding(false);
      ref.current?.focus();
    }
  };

  const send = async () => {
    const text = draft.trim();
    if ((!text && !files.length) || busy) return;
    const sent = files;
    setBusy(true);
    setDraft('');
    setFiles([]);
    try {
      await api.message(taskId, { text, mode: 'chat', runId, files: sent.length ? sent : undefined });
    } catch (err) {
      setDraft(text);
      setFiles(sent);
      toast(errorMessage(err), { error: true });
    } finally {
      setBusy(false);
    }
  };
  const stop = async () => {
    setBusy(true);
    try {
      await api.interrupt(taskId);
      ref.current?.focus();
    } catch (err) {
      toast(errorMessage(err), { error: true });
    } finally {
      setBusy(false);
    }
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };
  // A screenshot arrives as a file on the clipboard. Pasted text keeps the normal behaviour.
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const picked = filesOf(e.clipboardData?.files);
    if (!picked.length) return;
    e.preventDefault();
    void add(picked);
  };
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    const picked = filesOf(e.dataTransfer?.files);
    setOver(false);
    if (!picked.length) return;
    e.preventDefault();
    void add(picked);
  };
  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!Array.from(e.dataTransfer?.types ?? []).includes('Files')) return;
    e.preventDefault();
    setOver(true);
  };

  const hasText = !!draft.trim();
  const showStop = working && canStop && !hasText && !files.length;
  const placeholder = waiting ? `Reply to ${who}…` : working ? `Message ${who}. It reads this after its current action.` : reopened ? 'Ask about this session. The task doesn’t move.' : `Message ${who}…`;
  const status = adding ? 'adds your file…' : over ? 'drop the file here' : working ? 'working' : waiting ? 'waiting for you' : reopened ? 'reopened; doesn’t move the task' : '';

  return (
    <div className={`ox-composer${over ? ' ox-over' : ''}`} onDragOver={onDragOver} onDragLeave={() => setOver(false)} onDrop={onDrop}>
      <Chips taskId={taskId} files={files} onRemove={(path) => setFiles((f) => f.filter((x) => x.path !== path))} />
      <textarea ref={ref} aria-label={placeholder} placeholder={placeholder} value={draft} rows={Math.min(8, Math.max(2, draft.split('\n').length))} onChange={(e) => setDraft(e.target.value)} onKeyDown={onKey} onPaste={onPaste} />
      <div className="ox-cfoot">
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            void add(filesOf(e.target.files));
            e.target.value = '';
          }}
        />
        <button className="ox-clip" aria-label="Add a file" title="Add a file. You can also paste or drop one." onClick={() => picker.current?.click()} disabled={adding || busy}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21.4 11.1l-8.5 8.5a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8" />
          </svg>
        </button>
        <span className="ox-cctx">
          <span className="lx-av ox-av" style={{ background: color, width: 14, height: 14, fontSize: 8.5 }}>
            {av}
          </span>
          {who}
        </span>
        {branch && (
          <span className="ox-cctx ox-cbranch" title="The branch this session works on">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="6" cy="5" r="2.5" />
              <circle cx="6" cy="19" r="2.5" />
              <circle cx="18" cy="8" r="2.5" />
              <path d="M6 7.5v9M18 10.5c0 4-6 3-12 6" />
            </svg>
            {branch}
          </span>
        )}
        <span className="ox-cstat">{status}</span>
        {showStop ? (
          <button className="ox-send ox-stopbtn" aria-label={`Stop ${who}`} title={`Stop ${who}’s current turn`} onClick={() => void stop()} disabled={busy}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M6 6h12v12H6z" />
            </svg>
          </button>
        ) : (
          <button className="ox-send" aria-label="Send" onClick={() => void send()} disabled={(!hasText && !files.length) || busy || adding}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 19V5M5 12l7-7 7 7" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}
