import { useEffect, useState } from 'react';
import { api, errorMessage, type TaskSummary, type WorkflowInfo, type Workspace, type WorkspaceInput } from '../api';
import { shortPath } from '../components/GitPanel';
import { PlusIcon, WorkspacesIcon } from '../components/Icons';
import { Modal, useToast } from '../components/Overlay';
import { RepoField } from '../components/RepoField';
import { SettingsCard, SettingsRow } from '../components/SettingsRow';
import { useLiveResource } from '../lib/live';
import { store } from '../lib/remember';
import { href, navigate } from '../lib/router';
import { STATE, stepLabel, taskState } from '../lib/taskState';

/** The Tasks filter remembers a workspace here, so "Open in Tasks" lands on that workspace's tasks. */
export const TASKS_WORKSPACE_KEY = 'orstra.tasks.workspace';

const stem = (file: string) => file.replace(/\.ya?ml$/, '');
const group = (t: TaskSummary) => STATE[taskState(t)].group;

/** "1 needs you", else "2 running", else "3 tasks", for a workspace's row in the list. */
function rowCount(tasks: TaskSummary[]): { text: string; color: string } {
  const needs = tasks.filter((t) => group(t) === 'needs').length;
  if (needs) return { text: `${needs} need${needs === 1 ? 's' : ''} you`, color: 'var(--purple-fg)' };
  const running = tasks.filter((t) => group(t) === 'running').length;
  if (running) return { text: `${running} running`, color: 'var(--accent-fg)' };
  return { text: tasks.length ? `${tasks.length} task${tasks.length === 1 ? '' : 's'}` : 'No tasks', color: 'var(--faint)' };
}

/**
 * Workspaces: where tasks work. The list on the left, and the open workspace's home on the right,
 * with its Overview (counts and active tasks) and its Settings (repo, base branch, setup).
 */
export function WorkspacesPage({ id, tab, onNewTask }: { id?: string; tab: 'overview' | 'settings'; onNewTask: (workspace?: string) => void }) {
  const res = useLiveResource('workspaces', api.workspaces, () => false);
  const tasks = useLiveResource('ws:tasks', api.tasks, undefined, 1000);
  const all = res.data ?? [];
  const adding = id === 'new';
  const open = adding ? null : all.find((w) => w.id === id) ?? null;

  // Open the first workspace when none is named, so the page never shows an empty right side.
  useEffect(() => {
    if (!id && all.length) navigate(href.workspace(all[0].id));
  }, [id, all.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const tasksOf = (w: Workspace) => (tasks.data ?? []).filter((t) => t.workspace?.id === w.id);

  return (
    <>
      <div className="lx-bar">
        <span className="lx-crumb">
          <b>Workspaces</b>
        </span>
        <div className="lx-acts">
          <button className="lx-btn lx-pri" onClick={() => navigate(href.workspace('new'))}>
            <PlusIcon />
            Add workspace
          </button>
        </div>
      </div>

      {res.error && !res.data && <div className="lx-error">{res.error}</div>}
      {res.loading && !res.data && (
        <div className="lx-loading">
          <span className="lx-spin" /> Loading workspaces…
        </div>
      )}

      {res.data && all.length === 0 && !adding && (
        <div className="lx-empty">
          <span style={{ color: 'var(--dim)' }}>
            <WorkspacesIcon />
          </span>
          <b>No workspaces yet</b>
          <span>A workspace is 1 repo and the branch new tasks start from. Every task works in one.</span>
          <button className="lx-btn lx-pri" onClick={() => navigate(href.workspace('new'))}>
            <PlusIcon />
            Add workspace
          </button>
        </div>
      )}

      {res.data && (all.length > 0 || adding) && (
        <div className="ox-wssplit">
          <nav className="ox-wslist" aria-label="All workspaces">
            {all.map((w) => {
              const c = rowCount(tasksOf(w));
              return (
                <a key={w.id} className="ox-wsrow" href={href.workspace(w.id)} aria-current={w.id === open?.id ? 'true' : undefined}>
                  <span className="ox-wsname ox-trunc">{w.name}</span>
                  <span className="ox-wscount" style={{ color: c.color }}>
                    {c.text}
                  </span>
                  <span className="ox-wsmeta ox-trunc">
                    {shortPath(w.repoPath)} · {w.baseBranch}
                  </span>
                </a>
              );
            })}
            {adding && (
              <span className="ox-wsrow" aria-current="true">
                <span className="ox-wsname">New workspace</span>
              </span>
            )}
          </nav>
          <div className="ox-smain">
            <div className="ox-sdoc ox-wsdoc">
              {adding && <WorkspaceForm onSaved={(w) => { void res.reload(); navigate(href.workspace(w.id)); }} />}
              {!adding && id && !open && <div className="lx-error">There is no workspace with the id {id}.</div>}
              {open && (
                <>
                  <div className="ox-wshead">
                    <div style={{ minWidth: 0 }}>
                      <h1 className="ox-h1">{open.name}</h1>
                      <div className="ox-sub lx-mono">
                        {shortPath(open.repoPath)} · base {open.baseBranch}
                        {open.subdir ? ` · ${open.subdir}` : ''}
                      </div>
                    </div>
                    <button className="lx-btn" onClick={() => onNewTask(open.id)}>
                      <PlusIcon />
                      New task in {open.name}
                    </button>
                  </div>
                  <div className="ox-seg" role="group" aria-label="Workspace view" style={{ marginLeft: 0, alignSelf: 'flex-start' }}>
                    <a href={href.workspace(open.id)} aria-current={tab === 'overview' ? 'page' : undefined}>
                      Overview
                    </a>
                    <a href={href.workspace(open.id, 'settings')} aria-current={tab === 'settings' ? 'page' : undefined}>
                      Settings
                    </a>
                  </div>
                  {tab === 'overview' && <Overview ws={open} tasks={tasksOf(open)} />}
                  {tab === 'settings' && (
                    <WorkspaceForm
                      key={open.id + open.updatedAt}
                      ws={open}
                      taskCount={tasksOf(open).length}
                      onSaved={() => void res.reload()}
                      onRemoved={() => {
                        void res.reload();
                        navigate(href.workspaces);
                      }}
                    />
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function Overview({ ws, tasks }: { ws: Workspace; tasks: TaskSummary[] }) {
  const week = Date.now() - 7 * 24 * 3600_000;
  const active = tasks.filter((t) => group(t) !== 'done');
  const stat = (label: string, value: string | number, color?: string) => (
    <div className="ox-wsstat">
      <span>{label}</span>
      <b style={color ? { color } : undefined}>{value}</b>
    </div>
  );
  return (
    <div className="ox-sgroup">
      <div className="ox-wsstats">
        {stat('Running', tasks.filter((t) => group(t) === 'running').length)}
        {stat('Needs you', tasks.filter((t) => group(t) === 'needs').length, 'var(--purple-fg)')}
        {stat('Queued', tasks.filter((t) => group(t) === 'queued').length)}
        {stat('Done this week', tasks.filter((t) => group(t) === 'done' && t.updatedAt >= week).length)}
      </div>
      <section className="ox-sblock">
        <h2 className="ox-h2">
          Active tasks<span className="ox-gn">{active.length}</span>
          <a
            className="ox-link"
            style={{ marginLeft: 'auto', fontWeight: 400 }}
            href={href.tasks}
            onClick={() => store(TASKS_WORKSPACE_KEY, ws.id)}
          >
            Open in Tasks, filtered to {ws.name}
          </a>
        </h2>
        {active.length ? (
          <div className="ox-card">
            {active.map((t) => {
              const s = taskState(t);
              return (
                <a key={t.id} className="ox-lrow" href={href.task(t.id)}>
                  <span className={`ox-sd${s === 'working' ? ' ox-live' : ''}`} style={{ background: STATE[s].fg }} title={STATE[s].label} />
                  <span className="ox-trunc" title={t.id}>
                    {t.ref && <span className="ox-id">{t.ref} </span>}
                    {t.title}
                  </span>
                  <span className="ox-lstep">
                    {stepLabel(t)} · {STATE[s].short}
                  </span>
                </a>
              );
            })}
          </div>
        ) : (
          <div className="ox-calm">No active tasks in {ws.name}.</div>
        )}
      </section>
      <SettingsCard title="Where tasks work">
        <SettingsRow label="Repo" help="Each task gets its own worktree of this repo.">
          <span className="ox-val lx-mono">{shortPath(ws.repoPath)}</span>
        </SettingsRow>
        <SettingsRow label="Base branch" help="New tasks start from it. A task can pick another.">
          <span className="ox-val lx-mono">{ws.baseBranch}</span>
        </SettingsRow>
        <SettingsRow label="Agents start in" help="The folder agents and checks start in.">
          <span className="ox-val lx-mono">{ws.subdir || 'the repo root'}</span>
        </SettingsRow>
        <SettingsRow label="Setup" help="Runs once in a new worktree, before the first agent or check.">
          <span className="ox-val lx-mono">{[...ws.setup, ...ws.copyFiles.map((f) => `copy ${f}`)].join(' · ') || 'none'}</span>
        </SettingsRow>
      </SettingsCard>
    </div>
  );
}

const lines = (s: string) => s.split('\n').map((l) => l.trim()).filter(Boolean);
const envText = (env: Record<string, string>) => Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n');
function parseEnv(s: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const l of lines(s)) {
    const i = l.indexOf('=');
    if (i <= 0) throw new Error(`"${l}" is not KEY=value.`);
    env[l.slice(0, i).trim()] = l.slice(i + 1).trim();
  }
  return env;
}

/** Add a workspace (no `ws`), or change one. The daemon checks the repo, the branch and the folder. */
function WorkspaceForm({ ws, taskCount = 0, onSaved, onRemoved }: { ws?: Workspace; taskCount?: number; onSaved: (w: Workspace) => void; onRemoved?: () => void }) {
  const toast = useToast();
  const [name, setName] = useState(ws?.name ?? '');
  const [repoPath, setRepoPath] = useState(ws?.repoPath ?? '');
  const [baseBranch, setBaseBranch] = useState(ws?.baseBranch ?? '');
  const [subdir, setSubdir] = useState(ws?.subdir ?? '');
  const [defaultWorkflow, setDefaultWorkflow] = useState(ws?.defaultWorkflow ?? '');
  const [setup, setSetup] = useState((ws?.setup ?? []).join('\n'));
  const [copyFiles, setCopyFiles] = useState((ws?.copyFiles ?? []).join('\n'));
  const [env, setEnv] = useState(envText(ws?.env ?? {}));
  const [repoCheck, setRepoCheck] = useState<{ ok: boolean; baseBranch?: string; error?: string } | null>(null);
  const [workflows, setWorkflows] = useState<WorkflowInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  useEffect(() => {
    api.workflows().then(setWorkflows).catch(() => setWorkflows([]));
  }, []);

  const check = async (value: string) => {
    const repo = value.trim();
    if (!repo) return setRepoCheck(null);
    try {
      const r = await api.checkRepo(repo);
      setRepoCheck(r);
      if (r.ok && !name.trim()) setName(repo.replace(/\/+$/, '').split('/').pop() ?? '');
    } catch (err) {
      setRepoCheck({ ok: false, error: errorMessage(err) });
    }
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const input: WorkspaceInput = {
        name: name.trim(), repoPath: repoPath.trim(), baseBranch: baseBranch.trim() || undefined, subdir: subdir.trim(),
        defaultWorkflow: defaultWorkflow || null, setup: lines(setup), copyFiles: lines(copyFiles), env: parseEnv(env),
      };
      const saved = ws ? await api.updateWorkspace(ws.id, input) : await api.createWorkspace(input);
      toast(ws ? 'Workspace saved' : 'Workspace added');
      onSaved(saved);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!ws) return;
    try {
      await api.deleteWorkspace(ws.id);
      toast(`Removed ${ws.name}`);
      onRemoved?.();
    } catch (err) {
      setError(errorMessage(err));
    }
    setConfirmRemove(false);
  };

  return (
    <div className="ox-sgroup">
      {!ws && (
        <div className="ox-sghead" style={{ margin: 0 }}>
          <h1 className="ox-h1">Add a workspace</h1>
          <div className="ox-sub">1 repo, and the branch new tasks start from.</div>
        </div>
      )}
      <SettingsCard title="Where the code is">
        <SettingsRow label="Repo" help={repoCheck ? (repoCheck.ok ? <span style={{ color: 'var(--green-fg)' }}>Git repo found</span> : <span style={{ color: 'var(--red-fg)' }}>{repoCheck.error}</span>) : 'A local git repository with at least 1 commit.'}>
          <RepoField value={repoPath} onChange={setRepoPath} onDone={(v) => void check(v)} autoFocus={!ws} />
        </SettingsRow>
        <SettingsRow label="Name" help="Shown on task cards and in the New task form.">
          <input className="lx-input ox-wsin" aria-label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="hub" />
        </SettingsRow>
        <SettingsRow label="Base branch" help="New tasks start from it. A task can pick another. Empty: the repo's default.">
          <input className="lx-input lx-mono ox-wsin" aria-label="Base branch" value={baseBranch} onChange={(e) => setBaseBranch(e.target.value)} placeholder={repoCheck?.baseBranch ?? 'main'} />
        </SettingsRow>
        <SettingsRow label="Sub-directory" help="Agents and checks start here. Git stays repo-wide. Empty: the repo root.">
          <input className="lx-input lx-mono ox-wsin" aria-label="Sub-directory" value={subdir} onChange={(e) => setSubdir(e.target.value)} placeholder="apps/web" />
        </SettingsRow>
        <SettingsRow label="Default workflow" help="Picked first in the New task form.">
          <select className="lx-select ox-wsin" aria-label="Default workflow" value={defaultWorkflow} onChange={(e) => setDefaultWorkflow(e.target.value)}>
            <option value="">None</option>
            {workflows.map((w) => (
              <option key={w.path} value={stem(w.file)}>
                {w.name}
              </option>
            ))}
          </select>
        </SettingsRow>
      </SettingsCard>
      <SettingsCard title="Prepare each new worktree" note="Setup runs once per task, before its first agent or check. If it fails, the task goes to your Inbox.">
        <SettingsRow label="Setup commands" help="1 per line, run in order.">
          <textarea className="lx-field lx-mono ox-wsin" aria-label="Setup commands" value={setup} onChange={(e) => setSetup(e.target.value)} placeholder="npm install" />
        </SettingsRow>
        <SettingsRow label="Files to copy" help="Gitignored files a fresh worktree lacks, 1 per line.">
          <textarea className="lx-field lx-mono ox-wsin" aria-label="Files to copy" value={copyFiles} onChange={(e) => setCopyFiles(e.target.value)} placeholder=".env.local" />
        </SettingsRow>
        <SettingsRow label="Environment variables" help="KEY=value, 1 per line, for every agent and check.">
          <textarea className="lx-field lx-mono ox-wsin" aria-label="Environment variables" value={env} onChange={(e) => setEnv(e.target.value)} placeholder="PORT=5317" />
        </SettingsRow>
      </SettingsCard>
      {error && <div className="lx-error" style={{ margin: 0 }}>{error}</div>}
      <div className="ox-wsacts">
        {ws && (
          <button className="lx-btn ox-wsdanger" onClick={() => setConfirmRemove(true)}>
            Remove workspace
          </button>
        )}
        <button className="lx-btn lx-pri" style={{ marginLeft: 'auto' }} disabled={busy || !repoPath.trim() || !name.trim()} onClick={() => void save()}>
          {busy && <span className="lx-spin" aria-hidden="true" />}
          {ws ? 'Save' : 'Add workspace'}
        </button>
      </div>
      {confirmRemove && ws && (
        <Modal
          crumb={<span>{ws.name}</span>}
          title="Remove this workspace?"
          onClose={() => setConfirmRemove(false)}
          footer={
            <>
              <button className="lx-btn" onClick={() => setConfirmRemove(false)}>
                Cancel
              </button>
              <button className="lx-btn ox-wsdanger" onClick={() => void remove()}>
                Remove
              </button>
            </>
          }
        >
          <p style={{ margin: 0, lineHeight: 1.5 }}>
            {taskCount ? `${taskCount} task${taskCount === 1 ? '' : 's'} use${taskCount === 1 ? 's' : ''} it. They keep their worktrees and branches, and lose only the link. ` : ''}
            The repo is not touched.
          </p>
        </Modal>
      )}
    </div>
  );
}
