import { useCallback, useEffect, useState } from 'react';
import { api, type TaskSummary } from '../api';
import { PlusIcon, TasksIcon } from '../components/Icons';
import { boardColumns } from '../lib/board';
import { useLiveResource, useNow } from '../lib/live';
import { remember, store } from '../lib/remember';
import { href, navigate, type TaskViewName } from '../lib/router';
import { InboxView } from './Inbox';
import { agentMeta, STATE, stepLabel, taskState, type StateGroup } from '../lib/taskState';
import { age } from '../lib/time';

type View = 'board' | 'list';
type Filter = 'all' | 'needs' | 'running' | 'done';
const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'needs', label: 'Needs you' },
  { id: 'running', label: 'Running now' },
  { id: 'done', label: 'Done' },
];
const LIST_GROUPS: { group: StateGroup; name: string; color: string }[] = [
  { group: 'needs', name: 'Needs you', color: 'var(--purple-fg)' },
  { group: 'running', name: 'Running', color: 'var(--accent-fg)' },
  { group: 'queued', name: 'Queued', color: 'var(--faint)' },
  { group: 'done', name: 'Done or stopped', color: 'var(--green-fg)' },
];

function StatusText({ t }: { t: TaskSummary }) {
  const s = taskState(t);
  const attempt = t.run && t.run.attempt > 1 && (s === 'working' || s === 'blocked' || s === 'paused') ? ` · attempt ${t.run.attempt}` : '';
  return (
    <span className="ox-st" style={{ color: STATE[s].fg }}>
      <span className={`ox-sd${s === 'working' ? ' ox-live' : ''}`} style={{ background: STATE[s].fg }} />
      {STATE[s].short}
      {attempt}
    </span>
  );
}

/**
 * All tasks, in 3 views. Inbox: what needs you across every workflow, with the selected task open beside
 * the list, so you can act on it there. Board groups one workflow's tasks by step; List groups by status.
 */
export function TasksPage({ onNewTask, inbox, sel, selView }: { onNewTask: () => void; inbox: boolean; sel?: string; selView?: TaskViewName }) {
  useNow(30_000);
  const [archived, setArchived] = useState(false);
  const res = useLiveResource(archived ? 'tasks:archived' : 'tasks', archived ? api.archivedTasks : api.tasks);
  const [view, setView] = useState<View>(() => remember<View>('orstra.tasks.view', 'board'));
  const [filter, setFilter] = useState<Filter>('all');
  const [wfFile, setWfFile] = useState<string | null>(null);
  const tasks = res.data ?? [];
  const needsCount = (archived ? [] : tasks).filter((t) => STATE[taskState(t)].group === 'needs').length;

  // Workflows that have tasks, the busiest first. The board shows one workflow at a time.
  const countOf = (f: string) => tasks.filter((t) => t.workflowFile === f).length;
  const files = [...new Map(tasks.map((t) => [t.workflowFile, t.workflow])).entries()].sort((a, b) => countOf(b[0]) - countOf(a[0]));
  const file = wfFile && files.some(([f]) => f === wfFile) ? wfFile : files[0]?.[0] ?? null;
  useEffect(() => store('orstra.tasks.view', view), [view]);

  const wf = useLiveResource(`wf:${file ?? ''}`, useCallback(() => (file ? api.workflow(file) : Promise.resolve(null)), [file]), () => false);
  const inGroup = (t: TaskSummary, f: Filter) => f === 'all' || STATE[taskState(t)].group === f;
  const shown = (t: TaskSummary) => inGroup(t, filter);
  const ofWorkflow = tasks.filter((t) => t.workflowFile === file);

  const columns = boardColumns(wf.data?.steps ?? [], ofWorkflow);

  return (
    <>
      <div className="lx-bar">
        <span className="lx-crumb">
          <b>Tasks</b>
        </span>
        <div className="ox-seg" role="group" aria-label="Tasks view">
          <button aria-pressed={inbox} onClick={() => navigate(href.inbox)}>
            Inbox
            {needsCount > 0 && <span className="ox-segn">{needsCount}</span>}
          </button>
          <button aria-pressed={!inbox && view === 'board'} onClick={() => { setView('board'); navigate(href.tasks); }}>
            Board
          </button>
          <button aria-pressed={!inbox && view === 'list'} onClick={() => { setView('list'); navigate(href.tasks); }}>
            List
          </button>
        </div>
        <div className="lx-acts">
          <button className="lx-btn" aria-pressed={archived && !inbox} onClick={() => { if (inbox) { setArchived(true); navigate(href.tasks); } else setArchived((a) => !a); }}>
            {archived && !inbox ? 'Back to tasks' : 'Archived'}
          </button>
          <button className="lx-btn lx-pri" onClick={onNewTask}>
            <PlusIcon />
            New task
          </button>
        </div>
      </div>

      {inbox && <InboxView sel={sel} selView={selView} />}
      {!inbox && res.error && !res.data && <div className="lx-error">{res.error}</div>}
      {!inbox && res.loading && !res.data && !res.error && (
        <div className="lx-loading">
          <span className="lx-spin" /> Loading tasks…
        </div>
      )}
      {!inbox && res.data && tasks.length === 0 && (
        <div className="lx-empty">
          <span style={{ color: 'var(--dim)' }}>
            <TasksIcon />
          </span>
          <b>No tasks yet</b>
          <span>A task is one thing moving through a workflow, like a ticket.</span>
          <button className="lx-btn lx-pri" onClick={onNewTask}>
            <PlusIcon />
            New task
          </button>
        </div>
      )}

      {!inbox && tasks.length > 0 && (
        <>
          <div className="ox-fbar">
            {FILTERS.map((f) => (
              <button key={f.id} className="ox-fchip" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
                {f.label}
                <span className="ox-fn">{tasks.filter((t) => inGroup(t, f.id)).length}</span>
              </button>
            ))}
            {view === 'board' && (
              <label className="ox-wfpick">
                Workflow
                <select className="lx-select" value={file ?? ''} onChange={(e) => setWfFile(e.target.value)} disabled={files.length < 2}>
                  {files.map(([f, name]) => (
                    <option key={f} value={f}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>

          {view === 'board' ? (
            <div className="ox-board">
              {wf.error && <div className="lx-error">Couldn’t read this workflow: {wf.error}</div>}
              {columns.map((c) =>
                c.cards.length === 0 ? (
                  <div key={c.id} className="ox-bempty" title="No tasks at this step">
                    <span>{c.name}</span>
                  </div>
                ) : (
                  <div key={c.id} className="ox-bcol">
                    <div className="ox-bch">
                      {c.name}
                      <span className="ox-gn">{c.cards.length}</span>
                    </div>
                    {c.cards.map((t) => {
                      const a = agentMeta(t);
                      return (
                        <a key={t.id} className="ox-tcard" href={href.task(t.id)} title={t.id} style={shown(t) ? undefined : { opacity: 0.3 }}>
                          {t.ref && <span className="ox-id">{t.ref}</span>}
                          <span className="ox-tct">{t.title}</span>
                          <span className="ox-tcf">
                            {/* The Done column says it: a done card shows no Done chip. */}
                            {t.status !== 'done' && <StatusText t={t} />}
                            <span className="lx-av ox-av" style={{ background: a.color, marginLeft: 'auto' }} title={a.name}>
                              {a.av}
                            </span>
                          </span>
                        </a>
                      );
                    })}
                  </div>
                ),
              )}
            </div>
          ) : (
            <div className="ox-list">
              {LIST_GROUPS.map((g) => {
                const rows = tasks.filter((t) => STATE[taskState(t)].group === g.group && shown(t));
                if (!rows.length) return null;
                return (
                  <div key={g.group}>
                    <div className="ox-lgh">
                      <span className="ox-sd" style={{ background: g.color }} />
                      {g.name}
                      <span className="ox-gn">{rows.length}</span>
                    </div>
                    {rows.map((t) => {
                      const s = taskState(t);
                      const a = agentMeta(t);
                      return (
                        <a key={t.id} className="ox-lrow" href={href.task(t.id)}>
                          <span className={`ox-sd${s === 'working' ? ' ox-live' : ''}`} style={{ background: STATE[s].fg }} title={STATE[s].label} />
                          <span className="ox-trunc" title={t.id}>
                            {t.ref && <span className="ox-id">{t.ref} </span>}
                            {t.title}
                          </span>
                          <span className="ox-lstep">
                            {s === 'done' || s === 'stopped' ? STATE[s].label : `${stepLabel(t)} · ${STATE[s].short}`} · {t.workflow}
                          </span>
                          <span className="lx-av ox-av" style={{ background: a.color }} title={a.name}>
                            {a.av}
                          </span>
                          <span className="ox-ltime">{age(t.updatedAt)}</span>
                        </a>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </>
  );
}
