import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { api, errorMessage } from '../api';
import { useToast } from './Overlay';

/**
 * The one message box: talks to Claude Code's session (mode 'chat'). While the agent is
 * working, a Stop button interrupts its current turn; the session stays open.
 */
export function ChatComposer({
  taskId,
  runId,
  working,
  awaiting,
  autoFocus,
  who = 'Claude Code',
  onSent,
}: {
  taskId: string;
  /** Target a specific run; otherwise the daemon picks the working/waiting/latest agent run. */
  runId?: string;
  working: boolean;
  awaiting?: boolean;
  autoFocus?: boolean;
  who?: string;
  onSent?: () => void;
}) {
  const toast = useToast();
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  const send = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setDraft('');
    try {
      await api.message(taskId, { text, mode: 'chat', runId });
      toast(`Sent to ${who}`);
      onSent?.();
    } catch (err) {
      setDraft(text);
      toast(errorMessage(err), { error: true });
    } finally {
      setSending(false);
    }
  };

  const stop = async () => {
    setStopping(true);
    try {
      await api.interrupt(taskId);
      toast(`Stopped. Tell ${who} what to do next.`);
      ref.current?.focus();
    } catch (err) {
      toast(errorMessage(err), { error: true });
    } finally {
      setStopping(false);
    }
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };

  const hint = working
    ? `${who} reads this after its current action`
    : awaiting
      ? `${who} is waiting for your reply`
      : `Continues the same ${who} session`;

  return (
    <div>
      <div className="lx-box">
        <textarea
          ref={ref}
          aria-label={`Message ${who}`}
          placeholder={`Message ${who}…`}
          value={draft}
          rows={Math.min(8, Math.max(2, draft.split('\n').length))}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKey}
        />
        <div className="lx-boxb">
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            {working && (
              <button className="lx-stop" onClick={() => void stop()} disabled={stopping} title={`Stop ${who}’s current turn`}>
                <span aria-hidden="true">■</span> Stop
              </button>
            )}
            <button className="lx-send" onClick={() => void send()} disabled={!draft.trim() || sending}>
              {sending && <span className="lx-spin" aria-hidden="true" />}
              Send
            </button>
          </div>
        </div>
      </div>
      <div className="lx-under">{hint}</div>
    </div>
  );
}

/** A note handed to a step's next run (for steps that haven't started). */
export function NoteInput({ taskId, stepId }: { taskId: string; stepId: string }) {
  const toast = useToast();
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      await api.message(taskId, { text, mode: 'note', stepId });
      setDraft('');
      toast('Note saved. The step reads it when it starts.');
    } catch (err) {
      toast(errorMessage(err), { error: true });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <textarea
        className="lx-field"
        aria-label="Note for this step"
        placeholder="e.g. Also run the e2e suite"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void save();
        }}
      />
      <div>
        <button className="lx-btn" onClick={() => void save()} disabled={!draft.trim() || busy}>
          {busy && <span className="lx-spin" aria-hidden="true" />}
          Save note
        </button>
      </div>
    </div>
  );
}

/** Ask a forked copy of a run's session. The answer comes back as an 'aside' event on the run. */
export function AskCopy({ taskId, runId, who = 'Claude Code' }: { taskId: string; runId: string; who?: string }) {
  const toast = useToast();
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const ask = async () => {
    const text = draft.trim();
    if (!text || pending) return;
    setPending(text);
    setDraft('');
    try {
      await api.message(taskId, { text, mode: 'ask', runId });
    } catch (err) {
      setDraft(text);
      toast(errorMessage(err), { error: true });
    } finally {
      setPending(null);
    }
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {pending && (
        <div className="lx-pending" style={{ padding: 0 }}>
          <span className="lx-spin" aria-hidden="true" />A copy is answering “{pending}”…
        </div>
      )}
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          className="lx-input"
          aria-label={`Ask a copy of ${who}`}
          placeholder="Ask a copy… (doesn’t touch the work)"
          value={draft}
          disabled={pending !== null}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void ask();
          }}
        />
        <button className="lx-btn" onClick={() => void ask()} disabled={!draft.trim() || pending !== null}>
          Ask
        </button>
      </div>
    </div>
  );
}
