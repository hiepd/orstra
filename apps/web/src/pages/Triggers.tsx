import { useEffect, useState } from 'react';
import { api, errorMessage, type Schedule, type ScheduleInput, type WorkflowInfo, type Workspace } from '../api';
import { shortPath } from '../components/GitPanel';
import { PlusIcon } from '../components/Icons';
import { Modal, useToast } from '../components/Overlay';
import { SettingsCard, SettingsRow, SettingsValue } from '../components/SettingsRow';
import { useLiveResource } from '../lib/live';
import { href } from '../lib/router';
import { ago } from '../lib/time';

const browserTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

/** "Thu 27 Nov, 09:00" in this browser's time, and "in 3 h" or "2 h ago". */
function at(ts: number | null): { text: string; rel: string } | null {
  if (!ts) return null;
  const text = new Date(ts).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const d = ts - Date.now();
  if (d <= 0) return { text, rel: ago(ts) };
  const m = Math.round(d / 60_000);
  const rel = m < 60 ? `in ${m} min` : m < 48 * 60 ? `in ${Math.round(m / 60)} h` : `in ${Math.round(m / 1440)} d`;
  return { text, rel };
}

/**
 * What starts tasks on its own. Schedules of both kinds in 1 list: declarative ones come from a workflow
 * file and are read-only here; imperative ones are made, changed and deleted here. Under them, the Linear
 * triggers and how their last check went.
 */
export function TriggersPage() {
  const res = useLiveResource('settings', api.settings, () => false);
  // A schedule that fires starts a task, so refetch on task changes too.
  const sched = useLiveResource('schedules', api.schedules, () => true, 1000);
  const [editing, setEditing] = useState<Schedule | 'new' | null>(null);
  const toast = useToast();
  const s = res.data;
  const linear = (s?.triggers ?? []).filter((t) => t.kind === 'linear');
  const list = sched.data ?? [];

  const toggle = async (x: Schedule) => {
    try {
      await api.setScheduleActive(x.id, !x.active);
      toast(x.active ? 'Schedule turned off' : 'Schedule turned on');
      void sched.reload();
    } catch (err) {
      toast(errorMessage(err));
    }
  };

  return (
    <>
      <div className="lx-bar">
        <div className="lx-crumb">
          <b>Triggers</b>
        </div>
        <div className="lx-acts">
          <button className="lx-btn lx-pri" onClick={() => setEditing('new')}>
            <PlusIcon />
            New schedule
          </button>
        </div>
      </div>
      <div className="ox-smain">
        <div className="ox-sdoc">
          <div className="ox-sghead">
            <h1 className="ox-h1">Triggers</h1>
            <div className="ox-sub">What starts tasks on its own: schedules and Linear issues.</div>
          </div>
          {(sched.error || res.error) && <div className="lx-error">{sched.error ?? res.error}</div>}
          {sched.loading && !sched.data && !sched.error && (
            <div className="lx-loading">
              <span className="lx-spin" /> Loading…
            </div>
          )}
          <div className="ox-sgroup">
            {sched.data && (
              <SettingsCard
                title="Schedules"
                note={
                  <>
                    A schedule from a workflow file changes only when you edit that file, for example{' '}
                    <code>triggers: [{'{'} schedule: {'{'} cron: "0 9 * * 1-5", timezone: Europe/London, title: Triage {'}'} {'}'}]</code>. Times show in
                    your browser’s timezone. A run missed while Orstra was off starts once when it is back.
                  </>
                }
              >
                {list.length === 0 ? (
                  <SettingsValue label="None yet" help="No workflow file lists a schedule, and none was made here." value="—" />
                ) : (
                  <>
                    <div className="ox-schrow ox-schhead" aria-hidden="true">
                      <span />
                      <span>Task · workflow</span>
                      <span>When</span>
                      <span>Next run</span>
                      <span>Last task</span>
                      <span />
                    </div>
                    {list.map((x) => (
                      <ScheduleRow key={x.id} s={x} onEdit={() => setEditing(x)} onToggle={() => void toggle(x)} />
                    ))}
                  </>
                )}
              </SettingsCard>
            )}
            {s && (
              <SettingsCard
                title="Linear"
                note={
                  <>
                    Set LINEAR_API_KEY in the daemon’s environment, and add <code>triggers: [{'{'} linear: {'{'} label: agent-ready {'}'} {'}'}]</code> to a workflow
                    file. Orstra checks every trigger once a minute (ORSTRA_TRIGGER_INTERVAL_S).
                  </>
                }
              >
                <SettingsValue label="Linear" help="A personal API key from Linear, in LINEAR_API_KEY." value={s.linear ? 'Connected' : 'No API key'} ok={!!s.linear} />
                {linear.map((t) => (
                  <SettingsValue
                    key={`${t.workflow}:${t.label}`}
                    label={t.label}
                    help={t.lastError ? `${t.workflow} · ${t.lastError}` : `${t.workflow} · checked ${t.lastCheck ? ago(t.lastCheck) : 'not yet'}`}
                    value={t.lastError ? 'Error' : `${t.started} started`}
                    ok={!t.lastError}
                  />
                ))}
              </SettingsCard>
            )}
          </div>
        </div>
      </div>
      {editing && (
        <ScheduleForm
          s={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void sched.reload();
          }}
        />
      )}
    </>
  );
}

function ScheduleRow({ s, onEdit, onToggle }: { s: Schedule; onEdit: () => void; onToggle: () => void }) {
  const next = s.active ? at(s.nextRunAt) : null;
  const declared = s.kind === 'declarative';
  return (
    <div className={`ox-schrow${s.active ? '' : ' ox-schoff'}`}>
      <span className="ox-sd" style={{ background: s.lastError ? 'var(--red-fg)' : s.active ? 'var(--green-fg)' : 'var(--faint)' }} title={s.lastError ?? (s.active ? 'On' : 'Off')} />
      <span className="ox-schcell">
        <b className="ox-trunc">{s.title}</b>
        <span className="ox-schsub ox-trunc">
          {s.workflowName}
          {s.workspace ? ` · ${s.workspace.name}` : ''}
        </span>
      </span>
      <span className="ox-schcell" title={s.cron ?? undefined}>
        <span className="ox-trunc">{s.when}</span>
        <span className="ox-schsub ox-trunc lx-mono">
          {s.cron ?? 'interval'} · {s.cron ? s.timezone ?? 'UTC' : 'no timezone'}
        </span>
      </span>
      <span className="ox-schcell">
        {next ? (
          <>
            <span className="ox-trunc">{next.text}</span>
            <span className="ox-schsub">{next.rel}</span>
          </>
        ) : (
          <span className="ox-schsub">{s.active ? '—' : 'Off'}</span>
        )}
      </span>
      <span className="ox-schcell">
        {s.lastTask ? (
          <>
            <a className="ox-link ox-trunc" href={href.task(s.lastTask.id)} title={s.lastTask.title}>
              {s.lastTask.ref ?? s.lastTask.title}
            </a>
            <span className="ox-schsub">{at(s.lastRunAt)?.rel ?? ''}</span>
          </>
        ) : (
          <span className="ox-schsub">{s.lastError ? <span style={{ color: 'var(--red-fg)' }}>{s.lastError}</span> : 'None yet'}</span>
        )}
      </span>
      <span className="ox-schacts">
        {declared ? (
          <span className="ox-schsub ox-trunc" title={`Declared in ${s.workflowPath ?? s.workflow}. Edit that file to change it.`}>
            In {shortPath(s.workflowPath ?? s.workflow)}
          </span>
        ) : (
          <>
            <button className="lx-btn" onClick={onToggle} aria-label={s.active ? `Turn off ${s.title}` : `Turn on ${s.title}`}>
              {s.active ? 'Turn off' : 'Turn on'}
            </button>
            <button className="lx-btn" onClick={onEdit}>
              Edit
            </button>
          </>
        )}
      </span>
    </div>
  );
}

/** Make an imperative schedule (no `s`), or change or delete one. The daemon checks the cron and the timezone. */
function ScheduleForm({ s, onClose, onSaved }: { s?: Schedule; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [workflows, setWorkflows] = useState<WorkflowInfo[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workflow, setWorkflow] = useState(s?.workflow ?? '');
  const [cron, setCron] = useState(s?.cron ?? '0 9 * * 1-5');
  const [timezone, setTimezone] = useState(s ? s.timezone ?? 'UTC' : browserTimezone());
  const [title, setTitle] = useState(s?.title ?? '');
  const [description, setDescription] = useState(s?.description ?? '');
  const [prompt, setPrompt] = useState(s?.prompt ?? '');
  const [workspace, setWorkspace] = useState(s?.workspace?.id ?? '');
  const [preview, setPreview] = useState<{ when: string; next: number[] } | { error: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    api.workflows().then((w) => {
      setWorkflows(w);
      if (!s && w.length) setWorkflow((cur) => cur || w[0].file);
    }).catch(() => setWorkflows([]));
    api.workspaces().then((w) => {
      setWorkspaces(w);
      if (!s && w.length === 1) setWorkspace(w[0].id);
    }).catch(() => setWorkspaces([]));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // The cron in words and the next 3 runs, as you type.
  useEffect(() => {
    if (!cron.trim()) return setPreview(null);
    const t = setTimeout(() => {
      api.previewSchedule(cron, timezone.trim() === 'UTC' ? '' : timezone.trim()).then(setPreview, (err) => setPreview({ error: errorMessage(err) }));
    }, 250);
    return () => clearTimeout(t);
  }, [cron, timezone]);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const input: ScheduleInput = {
        workflow, cron: cron.trim(), timezone: timezone.trim() === 'UTC' ? null : timezone.trim() || null,
        title: title.trim(), description: description.trim(), prompt: prompt.trim() || null, workspace: workspace || null,
      };
      if (s) await api.updateSchedule(s.id, input);
      else {
        const r = await api.createSchedule(input);
        if (!r.created) toast('That schedule existed, so Orstra changed it');
      }
      toast(s ? 'Schedule saved' : 'Schedule made');
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!s) return;
    try {
      await api.deleteSchedule(s.id);
      toast('Schedule deleted');
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
      setConfirmDelete(false);
    }
  };

  if (confirmDelete && s) {
    return (
      <Modal
        crumb={<span>{s.title}</span>}
        title="Delete this schedule?"
        onClose={() => setConfirmDelete(false)}
        footer={
          <>
            <button className="lx-btn" onClick={() => setConfirmDelete(false)}>
              Cancel
            </button>
            <button className="lx-btn ox-wsdanger" onClick={() => void remove()}>
              Delete
            </button>
          </>
        }
      >
        <p style={{ margin: 0, lineHeight: 1.5 }}>It starts no more tasks. The tasks it started stay.</p>
      </Modal>
    );
  }

  return (
    <Modal
      crumb={<span>Triggers</span>}
      title={s ? 'Edit schedule' : 'New schedule'}
      width={640}
      onClose={onClose}
      footer={
        <>
          {s && (
            <button className="lx-btn ox-wsdanger" style={{ marginRight: 'auto' }} onClick={() => setConfirmDelete(true)}>
              Delete
            </button>
          )}
          <button className="lx-btn" onClick={onClose}>
            Cancel
          </button>
          <button className="lx-btn lx-pri" disabled={busy || !workflow || !cron.trim() || !title.trim()} onClick={() => void save()}>
            {busy && <span className="lx-spin" aria-hidden="true" />}
            {s ? 'Save' : 'Make schedule'}
          </button>
        </>
      }
    >
      <div className="ox-card">
        <SettingsRow label="Workflow" help="Each task follows it.">
          <select className="lx-select ox-wsin" aria-label="Workflow" value={workflow} onChange={(e) => setWorkflow(e.target.value)}>
            {workflows.map((w) => (
              <option key={w.path} value={w.file}>
                {w.name}
              </option>
            ))}
          </select>
        </SettingsRow>
        <SettingsRow
          label="Cron"
          help={
            preview && 'error' in preview ? (
              <span style={{ color: 'var(--red-fg)' }}>{preview.error}</span>
            ) : preview ? (
              <>
                <span style={{ color: 'var(--ink-2)' }}>{preview.when}</span>
                {preview.next.length > 0 && <> · next {preview.next.map((n) => at(n)?.text).join(', ')}</>}
              </>
            ) : (
              'minute hour day-of-month month day-of-week'
            )
          }
        >
          <input className="lx-input lx-mono ox-wsin" aria-label="Cron" value={cron} onChange={(e) => setCron(e.target.value)} placeholder="0 9 * * 1-5" />
        </SettingsRow>
        <SettingsRow label="Timezone" help="An IANA name. The cron's hours are in it.">
          <input className="lx-input lx-mono ox-wsin" aria-label="Timezone" value={timezone} onChange={(e) => setTimezone(e.target.value)} placeholder="Europe/London" />
        </SettingsRow>
        <SettingsRow label="Task title" help="{{ date }} and {{ time }} become when it is due, {{ last_run }} the date it last ran.">
          <input className="lx-input ox-wsin" aria-label="Task title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Triage {{ date }}" />
        </SettingsRow>
        <SettingsRow label="Prompt" help="What the agents of each task are told to do. Every agent step gets it, so the workflow needs no change. {{ last_run }} works here.">
          <textarea
            className="lx-field ox-wsin"
            aria-label="Prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Review what merged since {{ last_run }} and list what broke."
          />
        </SettingsRow>
        <SettingsRow label="Description" help="Shown on each task, as in the New task form. Optional.">
          <textarea className="lx-field ox-wsin" aria-label="Description" value={description} onChange={(e) => setDescription(e.target.value)} />
        </SettingsRow>
        <SettingsRow label="Workspace" help="Where each task works.">
          <select className="lx-select ox-wsin" aria-label="Workspace" value={workspace} onChange={(e) => setWorkspace(e.target.value)}>
            <option value="">{workspaces.length ? 'The workflow’s own repo' : 'No workspace'}</option>
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </SettingsRow>
      </div>
      {error && <div className="lx-error" style={{ margin: '12px 0 0' }}>{error}</div>}
    </Modal>
  );
}
