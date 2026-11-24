import { useMemo, useState, type ReactNode } from 'react';
import type { RunView, TaskEvent } from '../api';
import { useNow } from '../lib/live';
import { duration } from '../lib/time';
import { SentFiles } from './FileChips';
import { ChevronRight } from './Icons';
import { Markdown } from './Markdown';
import { RefChips } from './RefChips';
import { findRefs, type Ref } from '../lib/refs';
import { ProgressList } from './ProgressList';

type ToolEvent = Extract<TaskEvent, { kind: 'tool' }>;

const READ = /^(read|glob|grep|ls|notebookread|webfetch|websearch|toolsearch)/i;
const EDIT = /^(edit|write|multiedit|notebookedit)/i;
const ICON = {
  read: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z',
  edit: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z',
  cmd: 'm4 17 6-6-6-6M12 19h8',
};
const kindOf = (name: string) => (READ.test(name) ? 'read' : EDIT.test(name) ? 'edit' : 'cmd');
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "Read 2 files, ran 1 command and changed 2 files" */
function summarize(tools: ToolEvent[]): string {
  const count = { read: 0, edit: 0, cmd: 0 };
  tools.forEach((t) => count[kindOf(t.name)]++);
  const parts = [count.read && `read ${plural(count.read, 'file', 'files')}`, count.cmd && `ran ${plural(count.cmd, 'command', 'commands')}`, count.edit && `changed ${plural(count.edit, 'file', 'files')}`].filter(Boolean) as string[];
  const s = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0] ?? '';
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
}

function WorkFold({ tools, from, to, live }: { tools: ToolEvent[]; from: number; to: number; live: boolean }) {
  const [open, setOpen] = useState(false);
  useNow(live ? 1000 : 3_600_000);
  const last = tools[tools.length - 1];
  return (
    <div>
      <button className="ox-fold" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {live && <span className="ox-sd ox-live" style={{ background: 'var(--accent)', width: 6, height: 6 }} />}
        <span>{live ? `Working for ${duration(from, Date.now())}` : `Worked for ${duration(from, to)}`}</span>
        <ChevronRight open={open} size={11} />
        <span className="ox-fsum">{summarize(tools)}</span>
      </button>
      {open && (
        <div style={{ paddingTop: 6 }}>
          {tools.map((t) => (
            <div key={String(t.id)} className="ox-wrow" title={`${t.name} ${t.summary}`}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flex: 'none' }} aria-hidden="true">
                <path d={ICON[kindOf(t.name)]} />
              </svg>
              <span>{t.name}</span>
              <span className="ox-wt">{t.summary}</span>
            </div>
          ))}
        </div>
      )}
      {live && (
        <div className="ox-wrow" style={{ paddingTop: 8 }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flex: 'none' }} aria-hidden="true">
            <path d={ICON.cmd} />
          </svg>
          <span className="ox-shine">{last ? `${last.name} ${last.summary}` : 'Thinking…'}</span>
        </div>
      )}
    </div>
  );
}

/**
 * One session as a chat: the agent's messages as plain text, yours as bubbles on the right, and its
 * tool calls folded into "Worked for 1m 12s" rows. `working` shows the last stretch as live.
 */
export function Transcript({
  run,
  events,
  working,
  agentName,
  onOpenRef,
  hideAsides,
}: {
  run: RunView;
  events: TaskEvent[];
  working: boolean;
  agentName: string;
  /** Open a reference (a link, a file, an artifact) in the side viewer. */
  onOpenRef?: (r: Ref) => void;
  /** Questions to a copy and its answers show in the Side chat panel instead. */
  hideAsides?: boolean;
}) {
  const mine = events.filter((e) => e.runId === run.id && !(hideAsides && (e.kind === 'aside' || (e.kind === 'you' && e.mode === 'ask'))));
  const onLink = useMemo(() => (onOpenRef ? (href: string) => onOpenRef(findRefs(href)[0] ?? { kind: 'link', target: href, label: href }) : undefined), [onOpenRef]);
  const items: { key: string; node: ReactNode }[] = [];
  let tools: ToolEvent[] = [];
  let since = run.startedAt ?? run.createdAt;
  const flush = (until: number, live: boolean) => {
    if (tools.length || live) items.push({ key: `w${tools[0]?.id ?? 'live'}`, node: <WorkFold tools={tools} from={since} to={until} live={live} /> });
    tools = [];
    since = until;
  };

  for (const e of mine) {
    if (e.kind === 'tool') {
      tools.push(e);
      continue;
    }
    if (e.kind === 'output') continue;
    flush(e.ts, false);
    const key = String(e.id);
    if (e.kind === 'message')
      items.push({
        key,
        node: (
          <div className="ox-ai">
            <Markdown text={e.text} onLink={onLink} />
            {onOpenRef && <RefChips taskId={run.taskId} refs={findRefs(e.text)} onOpen={onOpenRef} />}
          </div>
        ),
      });
    else if (e.kind === 'aside')
      items.push({
        key,
        node: (
          <div className="ox-ai ox-aside">
            <span className="ox-tag">A copy of {agentName} answered; the run wasn’t touched</span>
            <Markdown text={e.text} />
          </div>
        ),
      });
    else if (e.kind === 'system') items.push({ key, node: <div className="ox-sys">{e.text}</div> });
    else if (e.kind === 'progress')
      items.push({
        key,
        node: (
          <div className="ox-pcard">
            <div className="ox-pcardh">Progress note, handed to the next step</div>
            <ProgressList progress={e} />
          </div>
        ),
      });
    else if (e.kind === 'you') {
      if (e.mode === 'interrupt') items.push({ key, node: <div className="ox-sys">You stopped {agentName}</div> });
      else if (e.text || e.files?.length)
        items.push({
          key,
          node: (
            <div className="ox-user">
              <div className="ox-bubble">
                {e.mode === 'ask' && <span className="ox-tag">Asked a copy</span>}
                {e.via === 'cos' && <span className="ox-tag">Sent by your assistant</span>}
                {e.text}
                {!!e.files?.length && <SentFiles to={{ kind: 'task', taskId: run.taskId }} files={e.files} />}
              </div>
            </div>
          ),
        });
    }
  }
  flush(run.endedAt ?? Date.now(), working);

  if (items.length === 0) return <div className="lx-hint" style={{ textAlign: 'center', padding: '24px 0' }}>{run.status === 'queued' ? 'This run hasn’t started yet.' : 'Nothing said yet.'}</div>;
  return (
    <>
      {items.map((it) => (
        <div key={it.key}>{it.node}</div>
      ))}
    </>
  );
}
