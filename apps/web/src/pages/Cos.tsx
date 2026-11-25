import { useState, type ReactNode } from 'react';
import { api, errorMessage, type CosEvent, type CosPermission, type CosPlan, type CosView, type TaskSummary } from '../api';
import { Composer } from '../components/Composer';
import { SentFiles } from '../components/FileChips';
import { ChevronRight } from '../components/Icons';
import { Markdown } from '../components/Markdown';
import { useToast } from '../components/Overlay';
import { useAutoScroll } from '../lib/autoScroll';
import type { AttachTo } from '../lib/attach';
import { splitReply } from '../lib/brief';
import { mentionedTasks, splitCard } from '../lib/mentions';
import { useLiveResource, useNow } from '../lib/live';
import { href } from '../lib/router';
import { STATE, stepLabel, taskState } from '../lib/taskState';
import { duration } from '../lib/time';

const SUGGESTIONS = ['What needs me?', 'What’s running right now?', 'What finished today?', 'Brief me on everything'];

/** The chief of staff keeps the files you add in its own folder, the one its session works in. */
const COS: AttachTo = { kind: 'cos' };

const TOOL_VERB: Record<string, string> = {
  list_tasks: 'Listed tasks',
  get_task: 'Read task',
  get_task_changes: 'Read the changes of',
  get_diff: 'Read a diff in',
  read_task_file: 'Read a file in',
  list_workflows: 'Listed workflows',
  list_watches: 'Listed follow-ups',
  show_tasks: 'Showed tasks',
  message_agent: 'Messaged the agent on',
  add_note: 'Left a note on',
  start_task: 'Start a task',
  retry_step: 'Re-run a step on',
  decide: 'Answer the decision on',
  stop_task: 'Stop',
  watch: 'Watch',
  unwatch: 'Stopped watching',
  // Its own tools. The target is a path, a pattern, a command or a URL, so each verb has to read well
  // with any of them (see summarizeTool in executors.ts). An unnamed tool shows its own name.
  Bash: 'Ran',
  Read: 'Read',
  Glob: 'Looked for',
  Grep: 'Searched',
  Edit: 'Changed',
  Write: 'Wrote',
  WebSearch: 'Searched the web for',
  WebFetch: 'Read the page',
};
const READS = new Set(['list_tasks', 'get_task', 'get_task_changes', 'get_diff', 'read_task_file', 'list_workflows', 'list_watches', 'Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch']);

const ICON = {
  read: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z',
  act: 'm4 17 6-6-6-6M12 19h8',
  check: 'm5 12 5 5 9-10',
  eye: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
};

type ToolEv = Extract<CosEvent, { kind: 'tool' }>;

/** The tool arguments as the CLI summarised them: often JSON. Show the task or title when there is one. */
function toolTarget(t: ToolEv): string {
  try {
    const v = JSON.parse(t.summary) as Record<string, unknown>;
    return String(v.task ?? v.title ?? v.workflow ?? '');
  } catch {
    return t.summary === '{}' ? '' : t.summary;
  }
}

function summarize(tools: ToolEv[]): string {
  const reads = tools.filter((t) => READS.has(t.name)).length;
  const acts = tools.length - reads;
  const parts = [reads && `looked at ${reads} ${reads === 1 ? 'thing' : 'things'}`, acts && `took ${acts} ${acts === 1 ? 'action' : 'actions'}`].filter(Boolean) as string[];
  const s = parts.join(' and ');
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
}

function WorkFold({ tools, from, to, live }: { tools: ToolEv[]; from: number; to: number; live: boolean }) {
  const [open, setOpen] = useState(false);
  useNow(live ? 1000 : 3_600_000);
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
            <div key={t.id} className="ox-wrow">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flex: 'none' }} aria-hidden="true">
                <path d={READS.has(t.name) ? ICON.read : ICON.act} />
              </svg>
              <span>{TOOL_VERB[t.name] ?? t.name}</span>
              <span className="ox-wt">{toolTarget(t)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TaskRows({ title, ids, tasks }: { title: string; ids: string[]; tasks: TaskSummary[] }) {
  const rows = ids.map((id) => tasks.find((t) => t.id === id)).filter(Boolean) as TaskSummary[];
  return (
    <div className="cs-card">
      <div className="cs-cardh">{title}</div>
      {rows.map((t) => {
        const s = taskState(t);
        const what = s === 'working' || s === 'checks' || s === 'queued' ? stepLabel(t) : s === 'done' || s === 'stopped' ? t.workflow : `${stepLabel(t)} · ${STATE[s].label}`;
        return (
          <a key={t.id} className="cs-trow" href={s === 'waiting_you' || s === 'paused' ? href.chat(t.id) : href.task(t.id)}>
            <span className={`ox-sd${s === 'working' ? ' ox-live' : ''}`} style={{ background: STATE[s].fg }} />
            {t.ref && <span className="ox-id">{t.ref}</span>}
            <span className="cs-tmain">
              <span className="cs-tt">{t.title}</span>
              <span className="cs-tw">{what}</span>
            </span>
            <span className="cs-tst" style={{ color: STATE[s].fg }}>
              {STATE[s].short}
            </span>
            <ChevronRight size={13} />
          </a>
        );
      })}
      {rows.length < ids.length && <div className="cs-tw" style={{ padding: '8px 12px' }}>{ids.length - rows.length} task(s) no longer exist.</div>}
    </div>
  );
}

function PlanCard({ plan }: { plan: CosPlan }) {
  const toast = useToast();
  const [busy, setBusy] = useState<'approve' | 'decline' | null>(null);
  const answer = async (a: 'approve' | 'decline') => {
    setBusy(a);
    try {
      await api.cosPlan(plan.id, a);
    } catch (err) {
      toast(errorMessage(err), { error: true });
    } finally {
      setBusy(null);
    }
  };
  const done = plan.status === 'approved';
  const state = plan.status === 'pending' ? ['Waiting for your OK', 'var(--purple-fg)'] : done ? ['Done', 'var(--green-fg)'] : ['Not done', 'var(--faint)'];
  return (
    <div className="cs-card cs-plan">
      <div className="cs-cardh">
        <span>{plan.actions.length === 1 ? 'Needs your OK' : `Plan · ${plan.actions.length} steps`}</span>
        <span className="cs-pstate" style={{ color: state[1] }}>
          {state[0]}
        </span>
      </div>
      {plan.actions.map((a, i) => (
        <div key={i} className="cs-pstep">
          <span className="cs-pn" style={done ? { background: 'var(--green-soft)', color: 'var(--green-fg)' } : undefined}>
            {done ? '✓' : i + 1}
          </span>
          <span>{a}</span>
        </div>
      ))}
      {plan.status === 'pending' && (
        <div className="cs-pfoot">
          <span className="ox-muted">Nothing happens until you say so.</span>
          <button className="lx-btn" onClick={() => void answer('decline')} disabled={busy !== null}>
            Not now
          </button>
          <button className="lx-btn lx-pri" onClick={() => void answer('approve')} disabled={busy !== null}>
            {busy === 'approve' && <span className="lx-spin" aria-hidden="true" />}
            Do it
          </button>
        </div>
      )}
    </div>
  );
}

function Did({ e }: { e: Extract<CosEvent, { kind: 'did' }> }) {
  const [open, setOpen] = useState(false);
  const card = e.detail ? { text: e.text, detail: e.detail } : splitCard(e.text);
  return (
    <div className="cs-did">
      <span className="cs-didic" style={e.watch ? { background: 'var(--accent-soft)', color: 'var(--accent-fg)' } : undefined}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d={e.watch ? ICON.eye : ICON.check} />
        </svg>
      </span>
      <div className="cs-didb">
        <div className="cs-didt">{card.text}</div>
        {card.detail && (
          <button className="ox-fold cs-didmore" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            <ChevronRight open={open} size={10} />
            <span>{open ? 'Hide the details' : 'Details'}</span>
          </button>
        )}
        {open && card.detail && <div className="cs-didd">{card.detail}</div>}
      </div>
      {e.taskId && (
        <a className="ox-link" style={{ lineHeight: '22px' }} href={e.view === 'chat' ? href.chat(e.taskId) : href.task(e.taskId)}>
          {e.view === 'chat' ? 'Open chat' : 'Open task'}
        </a>
      )}
      {!e.taskId && e.view === 'triggers' && (
        <a className="ox-link" style={{ lineHeight: '22px' }} href={href.triggers}>
          Open Triggers
        </a>
      )}
    </div>
  );
}

/**
 * A reply from the assistant: what happened first, then the rest in a fold. When it names tasks that
 * wait for you, each gets a button that opens it in the Inbox.
 */
function Reply({ text, tasks }: { text: string; tasks: TaskSummary[] }) {
  const [open, setOpen] = useState(false);
  const { lead, rest } = splitReply(text);
  const waiting = mentionedTasks(text, tasks.filter((t) => STATE[taskState(t)].group === 'needs')).slice(0, 2);
  return (
    <div className="ox-ai cs-ai">
      <Markdown text={lead} />
      {waiting.length > 0 && (
        <div className="cs-acts">
          {waiting.map((t, i) => (
            <a key={t.id} className={`lx-btn${i === 0 ? ' lx-pri' : ''}`} href={href.inboxTask(t.id, taskState(t) === 'waiting_you' ? 'chat' : 'overview')}>
              {waiting.length === 1 ? 'Open the task' : `Open “${t.title.length > 32 ? t.title.slice(0, 31) + '…' : t.title}”`}
            </a>
          ))}
        </div>
      )}
      {rest && (
        <>
          <button className="ox-fold cs-more" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            <ChevronRight open={open} size={11} />
            <span>{open ? 'Show less' : 'The details'}</span>
          </button>
          {open && <Markdown text={rest} />}
        </>
      )}
    </div>
  );
}

function Conversation({ view, tasks }: { view: CosView; tasks: TaskSummary[] }) {
  const items: { key: string; node: ReactNode }[] = [];
  let tools: ToolEv[] = [];
  let since = 0;
  const flush = (until: number, live: boolean) => {
    if (tools.length || live) items.push({ key: `w${tools[0]?.id ?? 'live'}`, node: <WorkFold tools={tools} from={since || until} to={until} live={live} /> });
    tools = [];
  };
  let lastDay = '';
  const lastMessage = [...view.events].reverse().find((e) => e.kind === 'message')?.id;
  for (const e of view.events) {
    const day = new Date(e.ts).toDateString();
    if (e.kind !== 'tool' && day !== lastDay) {
      flush(e.ts, false);
      lastDay = day;
      const today = day === new Date().toDateString();
      items.push({ key: `d${e.id}`, node: <div className="ox-sline">{today ? 'Today' : new Date(e.ts).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}</div> });
    }
    if (e.kind === 'tool') {
      tools.push(e); // the fold's time runs from the message before it: thinking counts as work
      continue;
    }
    flush(e.ts, false);
    since = e.ts;
    const key = String(e.id);
    if (e.kind === 'you')
      items.push({
        key,
        node: (
          <div className="ox-user">
            <div className="ox-bubble">
              {e.text}
              {!!e.files?.length && <SentFiles to={COS} files={e.files} />}
            </div>
          </div>
        ),
      });
    else if (e.kind === 'message') items.push({ key, node: <Reply text={e.text} tasks={e.id === lastMessage ? tasks : []} /> });
    else if (e.kind === 'show') items.push({ key, node: <TaskRows title={e.title} ids={e.taskIds} tasks={tasks} /> });
    else if (e.kind === 'plan') {
      const plan = view.plans.find((p) => p.id === e.planId);
      if (plan && plan.actions.length) items.push({ key, node: <PlanCard plan={plan} /> });
    } else if (e.kind === 'did') items.push({ key, node: <Did e={e} /> });
    else if (e.kind === 'system') items.push({ key, node: <div className="ox-sys">{e.text}</div> });
  }
  flush(Date.now(), view.working);

  if (!items.length)
    return (
      <div className="cs-intro">
        <b>Your assistant</b>
        <span>It keeps track of every task. Ask what needs you or how a task is going, or tell it what to do, like “tell Codex reposts count as duplicates” or “retry HUB-405 when HUB-432 is done”.</span>
        <span>It can read files, change files and run commands itself, and it asks before it starts a task or answers a decision. For real work on a task it goes through the task’s agent.</span>
      </div>
    );
  return (
    <>
      {items.map((it) => (
        <div key={it.key}>{it.node}</div>
      ))}
    </>
  );
}

function CosComposer({ working, empty }: { working: boolean; empty: boolean }) {
  const toast = useToast();
  const say = async (text: string) => {
    try {
      await api.cosSay(text);
    } catch (err) {
      toast(errorMessage(err), { error: true });
    }
  };
  return (
    <div className="ox-compwrap cs-compwrap">
      {!working && (
        <div className="cs-sugs">
          {SUGGESTIONS.slice(0, empty ? 4 : 3).map((s) => (
            <button key={s} className="cs-sug" onClick={() => void say(s)}>
              {s}
            </button>
          ))}
        </div>
      )}
      <Composer
        to={COS}
        who="Assistant"
        av="O"
        color="var(--solid)"
        placeholder={working ? 'It reads this when it finishes what it’s doing…' : 'Ask about your tasks, or tell me what to do…'}
        status={working ? 'working' : ''}
        working={working}
        autoFocus
        onSend={(text, files) => api.cosSay(text, files.length ? files : undefined).then(() => undefined)}
        onStop={() => api.cosInterrupt().then(() => undefined)}
      />
    </div>
  );
}

const UNTIL: Record<string, string> = { done: 'is done', needs_you: 'needs you', stopped: 'is stopped', finished: 'finishes' };

function Side({ view }: { view: CosView }) {
  const toast = useToast();
  const setPerm = async (key: CosPermission, value: boolean) => {
    try {
      await api.cosPermission(key, value);
      toast('Saved');
    } catch (err) {
      toast(errorMessage(err), { error: true });
    }
  };
  const unwatch = async (id: string) => {
    try {
      await api.cosUnwatch(id);
    } catch (err) {
      toast(errorMessage(err), { error: true });
    }
  };
  const perms: { key: CosPermission | null; label: string; sub: string; fixed?: string }[] = [
    { key: null, label: 'Answer questions about your tasks', sub: 'Reads tasks, runs, sessions and worktrees', fixed: 'Always on' },
    { key: 'msg', label: 'Message agents and leave notes', sub: 'Shows on the task as sent by your assistant' },
    { key: 'start', label: 'Start and retry tasks', sub: 'Otherwise it shows a plan and waits for your OK' },
    { key: null, label: 'Answer decisions or stop tasks', sub: 'Decisions are yours', fixed: 'Always asks' },
  ];
  return (
    <aside className="cs-side" aria-label="What your assistant is doing">
      <div className="cs-sh">Watching for you
      </div>
      {view.watches.map((w) => (
        <div key={w.id} className="cs-wrow">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flex: 'none', marginTop: 2 }} aria-hidden="true">
            <path d={ICON.eye} />
          </svg>
          <div style={{ flex: 1, minWidth: 0 }}>
            <a className="cs-wt" href={href.task(w.taskId)}>
              When {w.task} {UNTIL[w.until] ?? w.until}
            </a>
            <div className="cs-ws">{w.instruction}</div>
          </div>
          <button className="lx-ib" style={{ width: 22, height: 22 }} aria-label={`Stop watching ${w.task}`} title="Stop watching" onClick={() => void unwatch(w.id)}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </div>
      ))}
      {view.watches.length === 0 && <div className="lx-hint" style={{ padding: '4px 2px' }}>Nothing. Ask it to “tell me when…” or “do X after Y”.</div>}

      <div className="cs-sh" style={{ marginTop: 18 }}>
        Can do without asking
      </div>
      {perms.map((p) => {
        const on = p.key ? view.permissions[p.key] : false;
        return (
          <div key={p.label} className="cs-prow">
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="cs-wt">{p.label}</div>
              <div className="cs-ws">{p.sub}</div>
            </div>
            {p.fixed ? (
              <span className="ox-muted" style={{ whiteSpace: 'nowrap' }}>
                {p.fixed}
              </span>
            ) : (
              <button className="cs-tog" role="switch" aria-checked={on} aria-label={p.label} onClick={() => p.key && void setPerm(p.key, !on)}>
                <i />
              </button>
            )}
          </div>
        );
      })}
      <div className="lx-hint" style={{ marginTop: 10, lineHeight: 1.5 }}>
        Everything it does shows on the task too, marked as done by your assistant.
      </div>
    </aside>
  );
}

/** One ongoing conversation with an agent that sees every task and acts on them through Orstra. */
export function CosPage() {
  const res = useLiveResource('cos', api.cos, (id) => id === 'cos');
  // The side list of tasks. It needs no more than a refetch a second, even while an agent streams.
  const tasks = useLiveResource('cos:tasks', api.tasks, undefined, 1000);
  const view = res.data;
  const scroll = useAutoScroll<HTMLDivElement>(`${view?.events.length ?? 0}:${view?.working}`);
  return (
    <>
      <div className="lx-bar">
        <span className="lx-crumb">
          <b>Assistant</b>
        </span>
        <span className="lx-muted">Watches every task, briefs you, and acts when you ask.</span>
      </div>
      {res.error && !view && <div className="lx-error">{res.error}</div>}
      {res.loading && !view && !res.error && (
        <div className="lx-loading">
          <span className="lx-spin" /> Loading…
        </div>
      )}
      {view && (
        <div className="cs-body">
          <section className="ox-chat" aria-label="Assistant chat">
            <div className="ox-cscroll" ref={scroll.ref} onScroll={scroll.onScroll} style={{ paddingBottom: 230 }}>
              <div className="ox-lane">
                <Conversation view={view} tasks={tasks.data ?? []} />
              </div>
            </div>
            <CosComposer working={view.working} empty={view.events.length === 0} />
          </section>
          <Side view={view} />
        </div>
      )}
    </>
  );
}
