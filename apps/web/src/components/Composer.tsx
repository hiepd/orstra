import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type ReactNode } from 'react';
import { errorMessage, type ChatFile } from '../api';
import { filesOf, upload, type AttachTo } from '../lib/attach';
import { DraftFiles } from './FileChips';
import { useToast } from './Overlay';

const INSERT_EVENT = 'orstra:insert-draft';
const keyOf = (to: AttachTo) => (to.kind === 'task' ? `task:${to.taskId}` : 'cos');

/** Put text in the draft of a chat's composer (the one with acceptsInserts), for example a terminal's output. */
export function insertIntoDraft(to: AttachTo, text: string) {
  window.dispatchEvent(new CustomEvent(INSERT_EVENT, { detail: { key: keyOf(to), text } }));
}

/**
 * The message box, shared by a task's session and by the chief of staff. Enter sends. While the agent
 * works and the box is empty, the button stops its current turn.
 *
 * You add a file in 3 ways: paste it, drop it on the box, or pick it. Orstra writes it into the folder
 * the agent works in and puts its path at the end of your message, so the agent can open it.
 */
export function Composer({
  to,
  who,
  av,
  color,
  placeholder,
  status,
  working,
  canStop = true,
  autoFocus,
  focusWhen,
  acceptsInserts,
  context,
  onSend,
  onStop,
}: {
  to: AttachTo;
  who: string;
  av: string;
  color: string;
  placeholder: string;
  /** What the box says about the chat right now, e.g. "working". Files and drops override it. */
  status: string;
  /** The agent is in the middle of a turn. */
  working: boolean;
  /** Offer the stop button at all. A task offers it only for the run the task is on. */
  canStop?: boolean;
  autoFocus?: boolean;
  /** Focus the box when this turns true (the agent started to wait for you). */
  focusWhen?: boolean;
  /** Take text that another part of the page puts in the draft (insertIntoDraft), for this chat. */
  acceptsInserts?: boolean;
  /** An extra chip in the footer, such as the branch a session works on. */
  context?: ReactNode;
  /** Throw to keep the draft and the files in the box. */
  onSend: (text: string, files: ChatFile[]) => Promise<void>;
  onStop: () => Promise<void>;
}) {
  const toast = useToast();
  const [draft, setDraft] = useState('');
  const [files, setFiles] = useState<ChatFile[]>([]);
  const [busy, setBusy] = useState(false);
  /** A file is on its way to the folder. */
  const [adding, setAdding] = useState(false);
  const [over, setOver] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (focusWhen) ref.current?.focus();
  }, [focusWhen]);

  const insertKey = keyOf(to);
  useEffect(() => {
    if (!acceptsInserts) return;
    const onInsert = (e: Event) => {
      const d = (e as CustomEvent<{ key: string; text: string }>).detail;
      if (d.key !== insertKey) return;
      setDraft((t) => (t.trim() ? `${t.trimEnd()}\n\n${d.text}` : d.text));
      ref.current?.focus();
    };
    window.addEventListener(INSERT_EVENT, onInsert);
    return () => window.removeEventListener(INSERT_EVENT, onInsert);
  }, [acceptsInserts, insertKey]);

  const add = async (picked: File[]) => {
    if (!picked.length) return;
    setAdding(true);
    try {
      const res = await upload(to, picked, files);
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
      await onSend(text, sent);
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
      await onStop();
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
  const line = adding ? 'adds your file…' : over ? 'drop the file here' : status;

  return (
    <div className={`ox-composer${over ? ' ox-over' : ''}`} onDragOver={onDragOver} onDragLeave={() => setOver(false)} onDrop={onDrop}>
      <DraftFiles to={to} files={files} onRemove={(path) => setFiles((f) => f.filter((x) => x.path !== path))} />
      <textarea
        ref={ref}
        aria-label={placeholder}
        placeholder={placeholder}
        value={draft}
        rows={Math.min(8, Math.max(2, draft.split('\n').length))}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKey}
        onPaste={onPaste}
        autoFocus={autoFocus}
      />
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
        {context}
        <span className="ox-cstat">{line}</span>
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
