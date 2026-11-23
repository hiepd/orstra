import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { RunView, StepView, TaskEvent } from '../api';
import { AGENTS, agentOf } from '../lib/format';
import { clock } from '../lib/time';
import { InfoIcon, NoteIcon, StopIcon, ToolIcon } from './Icons';
import { ProgressList } from './ProgressList';

type Item = { key: string; node: ReactNode };

/**
 * Linear-style activity: agent messages, tool calls, gate output (grouped), progress entries,
 * your messages, notes, side answers and system lines. Oldest first.
 */
export function EventFeed({
  events,
  runs,
  steps,
  limit = 150,
  compact,
  empty,
}: {
  events: TaskEvent[];
  runs: RunView[];
  steps: StepView[];
  limit?: number;
  compact?: boolean;
  empty?: ReactNode;
}) {
  const [showAll, setShowAll] = useState(false);
  const runById = new Map(runs.map((r) => [r.id, r]));
  const stepTitle = (id: string | null | undefined) => (id ? steps.find((s) => s.id === id)?.title ?? id : null);
  const agentFor = (runId: string | null) => {
    const r = runId ? runById.get(runId) : undefined;
    return r ? agentOf(r) : AGENTS['claude-code'];
  };

  const items: Item[] = [];
  let prevYouText: string | null = null;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    const key = String(e.id);
    switch (e.kind) {
      case 'message': {
        const a = agentFor(e.runId);
        items.push({
          key,
          node: (
            <div className="lx-ev">
              <span className="lx-av" style={{ background: a.color }}>
                {a.av}
              </span>
              <div className="lx-evb">
                {!compact && <span className="lx-who">{a.name}</span>}
                {!compact && <time>{clock(e.ts)}</time>}
                <div>{e.text}</div>
              </div>
            </div>
          ),
        });
        break;
      }
      case 'tool':
        items.push({
          key,
          node: (
            <div className="lx-tool" title={`${e.name} ${e.summary}`}>
              <ToolIcon />
              <span>{e.name}</span>
              <code>{e.summary}</code>
            </div>
          ),
        });
        break;
      case 'output': {
        // Group consecutive output lines from the same run into one block.
        const lines = [e.text];
        while (i + 1 < events.length) {
          const n = events[i + 1];
          if (n.kind !== 'output' || n.runId !== e.runId) break;
          lines.push(n.text);
          i++;
        }
        items.push({ key, node: <pre className="lx-out">{lines.join('\n')}</pre> });
        break;
      }
      case 'progress': {
        const r = e.runId ? runById.get(e.runId) : undefined;
        items.push({
          key,
          node: (
            <div className="lx-note">
              <div className="lx-hint" style={{ marginBottom: 6 }}>
                Progress{r ? ` · ${r.stepTitle}${r.attempt > 1 ? ` · attempt ${r.attempt}` : ''}` : ''}
              </div>
              <ProgressList progress={e} />
            </div>
          ),
        });
        break;
      }
      case 'you': {
        if (e.mode === 'interrupt') {
          items.push({
            key,
            node: (
              <div className="lx-sys">
                <StopIcon />
                <span>You stopped {agentFor(e.runId).name}</span>
                <time>{clock(e.ts)}</time>
              </div>
            ),
          });
          break;
        }
        prevYouText = e.text;
        const step = e.mode === 'note' ? stepTitle(e.step) : null;
        const tag =
          e.mode === 'decision' ? (e.choice ? e.choice.replace(/_/g, ' ') : 'decision') : e.mode === 'ask' ? 'asked a copy' : e.mode === 'note' ? `note${step ? ` for ${step}` : ''}` : null;
        items.push({
          key,
          node: (
            <div className="lx-me">
              <div className="lx-memeta">
                {tag && <span className="lx-tag">{tag}</span>}
                <time>{clock(e.ts)}</time>
              </div>
              {e.text ? <div className={`lx-bubble${e.mode === 'chat' || e.mode === 'steer' ? '' : ' lx-quiet'}`}>{e.text}</div> : null}
            </div>
          ),
        });
        continue; // keep prevYouText for the next event
      }
      case 'note': {
        // The daemon also writes your message as a note; don't show it twice.
        if (prevYouText !== null && prevYouText === e.text) break;
        const step = stepTitle(e.step);
        items.push({
          key,
          node: (
            <div className="lx-sys">
              <NoteIcon />
              <span>
                {step ? `Note for ${step}: ` : 'Note: '}
                <span style={{ color: '#3C3C43' }}>{e.text}</span>
              </span>
              <time>{clock(e.ts)}</time>
            </div>
          ),
        });
        break;
      }
      case 'aside': {
        const a = agentFor(e.runId);
        items.push({
          key,
          node: (
            <div className="lx-ev">
              <span className="lx-av" style={{ background: '#8A8A93' }}>
                {a.av}
              </span>
              <div className="lx-evb lx-aside">
                <span className="lx-who" style={{ color: '#6F6F78' }}>
                  A copy of {a.name}
                </span>
                <time>didn’t affect the run</time>
                <div>{e.text}</div>
              </div>
            </div>
          ),
        });
        break;
      }
      case 'system':
        items.push({
          key,
          node: (
            <div className="lx-sys">
              <InfoIcon />
              <span>{e.text}</span>
              <time>{clock(e.ts)}</time>
            </div>
          ),
        });
        break;
    }
    prevYouText = null;
  }

  if (items.length === 0) return <>{empty ?? null}</>;
  const hidden = showAll ? 0 : Math.max(0, items.length - limit);
  return (
    <div className="lx-act" style={compact ? { gap: 10, marginTop: 0 } : undefined}>
      {hidden > 0 && (
        <button className="lx-more" onClick={() => setShowAll(true)}>
          Show {hidden} earlier
        </button>
      )}
      {items.slice(hidden).map((it) => (
        <div key={it.key}>{it.node}</div>
      ))}
    </div>
  );
}

/**
 * Keeps a scroll container pinned to the bottom when `dep` changes, as long as the user
 * was already near the bottom. Spread the result onto the scrolling element.
 */
export function useAutoScroll<T extends HTMLElement>(dep: unknown) {
  const ref = useRef<T>(null);
  const stick = useRef(true);
  const onScroll = () => {
    const el = ref.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };
  const first = useRef(true);
  useEffect(() => {
    // Don't jump on first render: the top of the page (decision, steps) matters most then.
    const el = ref.current;
    if (first.current) {
      first.current = false;
      if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
      return;
    }
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [dep]);
  return { ref, onScroll };
}
