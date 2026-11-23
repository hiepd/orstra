import { useEffect, useRef, useState } from 'react';
import { api, type TaskDetail } from '../api';
import { ChatComposer } from '../components/Composer';
import { AwaitingCard, DecisionCard, StuckBanner } from '../components/Decision';
import { EventFeed } from '../components/EventFeed';
import { InboxIcon, StuckCircle, WaitCircle } from '../components/Icons';
import { reasonText, taskLabel } from '../lib/format';
import { useLiveResource, useNow } from '../lib/live';
import { href } from '../lib/router';
import { age } from '../lib/time';

const isDecision = (t: TaskDetail) => t.human !== null;
const isAwaiting = (t: TaskDetail) => !!t.awaiting;

export function InboxPage() {
  const now = useNow(30_000);
  const res = useLiveResource('inbox', api.inbox);
  const [selId, setSelId] = useState<string | null>(null);
  const lastIndex = useRef(0);

  const all = res.data ?? [];
  const decisions = all.filter(isDecision).sort((a, b) => a.updatedAt - b.updatedAt);
  const waiting = all.filter((t) => !isDecision(t) && isAwaiting(t)).sort((a, b) => a.updatedAt - b.updatedAt);
  const stuck = all.filter((t) => !isDecision(t) && !isAwaiting(t)).sort((a, b) => a.updatedAt - b.updatedAt);
  const ordered = [...decisions, ...waiting, ...stuck];
  const groups = [
    { name: 'Decisions', items: decisions },
    { name: 'Waiting for your reply', items: waiting },
    { name: 'Stuck', items: stuck },
  ].filter((g) => g.items.length > 0);

  // Keep a selection: if the selected task left the inbox (you acted on it), move to the next one.
  let sel = ordered.find((t) => t.id === selId);
  if (!sel && ordered.length) sel = ordered[Math.min(lastIndex.current, ordered.length - 1)];
  const selIndex = sel ? ordered.indexOf(sel) : -1;
  useEffect(() => {
    if (selIndex >= 0) lastIndex.current = selIndex;
  }, [selIndex]);

  const sub = (t: TaskDetail) => `${taskLabel(t)} · ${t.human ? t.human.question : t.awaiting?.text ?? reasonText(t.inboxReason)}`;

  return (
    <>
      <div className="lx-bar">
        <div className="lx-crumb">
          <b>Inbox</b>
          {res.data && <span>{ordered.length ? `${ordered.length} need${ordered.length === 1 ? 's' : ''} you` : ''}</span>}
        </div>
        {sel && (
          <div className="lx-acts">
            <a className="lx-btn" href={href.task(sel.id)}>
              Open the task
            </a>
          </div>
        )}
      </div>
      {res.error && !res.data && <div className="lx-error">{res.error}</div>}
      {res.loading && !res.data && !res.error && (
        <div className="lx-loading">
          <span className="lx-spin" /> Loading…
        </div>
      )}
      {res.data && (
        <div className="lx-ibody">
          <nav className="lx-list" aria-label="Inbox items">
            {groups.map((g) => (
              <div key={g.name}>
                <div className="lx-lgh">
                  {g.name}
                  <span className="lx-cnt">{g.items.length}</span>
                </div>
                {g.items.map((t) => (
                  <button key={t.id} className="lx-irow" aria-current={t.id === sel?.id} onClick={() => setSelId(t.id)}>
                    <span className="lx-ic">{isDecision(t) || isAwaiting(t) ? <WaitCircle label={isDecision(t) ? 'Needs a decision' : 'Waiting for your reply'} /> : <StuckCircle />}</span>
                    <span className="lx-it">
                      <span className="lx-itt">{t.title}</span>
                      <span className="lx-its">{sub(t)}</span>
                    </span>
                    <span className="lx-age">{age(t.updatedAt, now)}</span>
                  </button>
                ))}
              </div>
            ))}
            {ordered.length === 0 && <div className="lx-lgh">Nothing needs you</div>}
          </nav>
          <section className="lx-pane" aria-label="Selected item">
            <div className="lx-scroll">
              {sel ? (
                <InboxDetail key={sel.id} task={sel} onDone={() => setSelId(ordered[selIndex + 1]?.id ?? ordered[selIndex - 1]?.id ?? null)} />
              ) : (
                <div className="lx-empty">
                  <InboxIcon size={28} stroke="#B4B5BD" strokeWidth={1.6} />
                  <b>You’re clear</b>
                  <span>
                    The factory is running. See what’s going on in <a href={href.sessions}>Sessions</a>.
                  </span>
                </div>
              )}
            </div>
          </section>
        </div>
      )}
    </>
  );
}

function InboxDetail({ task, onDone }: { task: TaskDetail; onDone: () => void }) {
  const recent = task.events.filter((e) => e.kind !== 'output').slice(-12);
  return (
    <div className="lx-doc2">
      <div className="lx-dmeta">
        {task.human || task.awaiting ? <WaitCircle /> : <StuckCircle />}
        <span>{task.human ? 'Decision' : task.awaiting ? 'Waiting for your reply' : 'Stuck'}</span>
        <span>·</span>
        <span className="lx-mono">{taskLabel(task)}</span>
        <span>·</span>
        <span>{task.workflow}</span>
        {task.currentStepTitle && (
          <>
            <span>·</span>
            <span>{task.currentStepTitle}</span>
          </>
        )}
      </div>
      <h1 className="lx-title">{task.title}</h1>
      {task.description && <p className="lx-desc">{task.description}</p>}
      {task.human ? (
        <DecisionCard task={task} onDone={onDone} />
      ) : task.awaiting ? (
        <AwaitingCard task={task}>
          <ChatComposer taskId={task.id} runId={task.awaiting.runId} working={false} awaiting autoFocus onSent={onDone} />
        </AwaitingCard>
      ) : (
        <StuckBanner task={task} onDone={onDone} />
      )}
      <div className="lx-shead">
        Recent activity
        <a className="lx-sright" style={{ fontWeight: 400, fontSize: 12.5 }} href={href.task(task.id)}>
          Open the task
        </a>
      </div>
      <EventFeed events={recent} runs={task.runs} steps={task.steps} empty={<div className="lx-hint">Nothing yet.</div>} />
    </div>
  );
}
