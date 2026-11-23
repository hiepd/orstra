import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { api, errorMessage } from '../api';
import { useToast } from './Overlay';

/**
 * The message box for one session. Enter sends. While the agent is working and the box is empty,
 * the button stops its current turn; the session stays open for your next message.
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
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (waiting) ref.current?.focus();
  }, [waiting]);

  const send = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    setDraft('');
    try {
      await api.message(taskId, { text, mode: 'chat', runId });
    } catch (err) {
      setDraft(text);
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

  const hasText = !!draft.trim();
  const showStop = working && canStop && !hasText;
  const placeholder = waiting ? `Reply to ${who}…` : working ? `Message ${who}. It reads this after its current action.` : reopened ? 'Ask about this session. The task doesn’t move.' : `Message ${who}…`;
  const status = working ? 'working' : waiting ? 'waiting for you' : reopened ? 'reopened; doesn’t move the task' : '';

  return (
    <div className="ox-composer">
      <textarea ref={ref} aria-label={placeholder} placeholder={placeholder} value={draft} rows={Math.min(8, Math.max(2, draft.split('\n').length))} onChange={(e) => setDraft(e.target.value)} onKeyDown={onKey} />
      <div className="ox-cfoot">
        <span className="ox-cctx">
          <span className="lx-av ox-av" style={{ background: color, width: 14, height: 14, fontSize: 8.5 }}>
            {av}
          </span>
          {who}
        </span>
        {branch && (
          <span className="ox-cctx" title="The branch this session works on">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="6" cy="5" r="2.5" />
              <circle cx="6" cy="19" r="2.5" />
              <circle cx="18" cy="8" r="2.5" />
              <path d="M6 7.5v9M18 10.5c0 4-6 3-12 6" />
            </svg>
            {branch}
          </span>
        )}
        <span>{status}</span>
        {showStop ? (
          <button className="ox-send ox-stopbtn" aria-label={`Stop ${who}`} title={`Stop ${who}’s current turn`} onClick={() => void stop()} disabled={busy}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M6 6h12v12H6z" />
            </svg>
          </button>
        ) : (
          <button className="ox-send" aria-label="Send" onClick={() => void send()} disabled={!hasText || busy}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 19V5M5 12l7-7 7 7" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}
