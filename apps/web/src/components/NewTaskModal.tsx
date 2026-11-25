import { useEffect, useState, type FormEvent } from 'react';
import { api, errorMessage, type WorkflowInfo, type Workspace } from '../api';
import { remember, store } from '../lib/remember';
import { href, navigate } from '../lib/router';
import { shortPath } from './GitPanel';
import { Modal, useToast } from './Overlay';

const stem = (file: string) => file.replace(/\.ya?ml$/, '');
const LAST = 'orstra.newTask.workspace';

/**
 * Start a task. Every task works in a workspace: it gives the repo, the branch to start from and the
 * folder agents start in. The form picks the workspace you used last; with none, it says why one is
 * needed and offers a repo path for this task only.
 */
export function NewTaskModal({ onClose, workspace: preset }: { onClose: () => void; workspace?: string }) {
  const toast = useToast();
  const [workflows, setWorkflows] = useState<WorkflowInfo[] | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [wsId, setWsId] = useState('');
  const [workflow, setWorkflow] = useState('');
  const [workflowTouched, setWorkflowTouched] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [ref, setRef] = useState('');
  const [baseBranch, setBaseBranch] = useState('');
  const [priority, setPriority] = useState('0');
  const [repo, setRepo] = useState('');
  const [repoOnce, setRepoOnce] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api.workflows(), api.workspaces()])
      .then(([wfs, wss]) => {
        setWorkflows(wfs);
        setWorkspaces(wss);
        const last = remember(LAST, '');
        const pick = wss.find((w) => w.id === preset) ?? wss.find((w) => w.id === last) ?? wss[0];
        if (pick) setWsId(pick.id);
        const def = pick?.defaultWorkflow && wfs.find((w) => stem(w.file) === stem(pick.defaultWorkflow!));
        setWorkflow(def ? stem(def.file) : wfs.length ? stem(wfs[0].file) : '');
      })
      .catch((err: unknown) => setLoadError(errorMessage(err)));
  }, [preset]);

  const ws = workspaces?.find((w) => w.id === wsId) ?? null;
  const pickWorkspace = (id: string) => {
    setWsId(id);
    setBaseBranch('');
    // Follow the workspace's default workflow until you choose one yourself.
    const next = workspaces?.find((w) => w.id === id);
    if (!workflowTouched && next?.defaultWorkflow && workflows?.some((w) => stem(w.file) === stem(next.defaultWorkflow!))) setWorkflow(stem(next.defaultWorkflow));
  };

  const noWorkspaces = workspaces !== null && workspaces.length === 0;
  const where = ws ? 'workspace' : repoOnce ? 'repo' : null;
  const canSubmit = !!workflow && !!title.trim() && !busy && (where === 'workspace' || (where === 'repo' && !!repo.trim()));
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const task = await api.createTask({
        workflow,
        title: title.trim(),
        description: description.trim() || undefined,
        ref: ref.trim() || undefined,
        workspace: ws ? ws.id : undefined,
        repo: !ws && repoOnce ? repo.trim() : undefined,
        baseBranch: baseBranch.trim() || undefined,
        priority: Number(priority) || undefined,
      });
      if (ws) store(LAST, ws.id);
      toast('Task started');
      onClose();
      navigate(href.task(task.id));
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  const base = baseBranch.trim() || ws?.baseBranch || '';

  return (
    <Modal
      crumb={<span>New task</span>}
      title="Start a task"
      onClose={onClose}
      width={580}
      footer={
        <>
          <button className="lx-btn" onClick={onClose}>
            Cancel
          </button>
          <button className="lx-btn lx-pri" onClick={() => void submit()} disabled={!canSubmit}>
            {busy && <span className="lx-spin" aria-hidden="true" />}
            Start task
          </button>
        </>
      }
    >
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {loadError && (
          <div className="lx-error" style={{ margin: 0 }}>
            {loadError}
          </div>
        )}

        {noWorkspaces && !repoOnce && (
          <div className="ox-wsneed">
            <b>A task needs a workspace</b>
            <span>A workspace tells the agent which repo to work in and which branch to start from. Without one, the agent gets an empty folder and stops.</span>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button
                type="button"
                className="lx-btn lx-pri"
                onClick={() => {
                  onClose();
                  navigate(href.workspace('new'));
                }}
              >
                Add a workspace
              </button>
              <button type="button" className="lx-btn" onClick={() => setRepoOnce(true)}>
                Use a repo path once
              </button>
            </div>
          </div>
        )}

        <div className="lx-row2">
          {!noWorkspaces && (
            <label className="lx-label">
              Workspace
              <select className="lx-select" value={wsId} onChange={(e) => pickWorkspace(e.target.value)} disabled={!workspaces}>
                {!workspaces && <option>Loading…</option>}
                {workspaces?.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {repoOnce && !ws && (
            <label className="lx-label">
              <span>
                Repo path <small>this task only</small>
              </span>
              <input className="lx-input lx-mono" value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="~/workspace/hub" autoFocus />
            </label>
          )}
          <label className="lx-label">
            Workflow
            {workflows && workflows.length === 0 ? (
              <span className="lx-hint">No workflows found. Add a YAML file to the workflows folder.</span>
            ) : (
              <select
                className="lx-select"
                value={workflow}
                onChange={(e) => {
                  setWorkflow(e.target.value);
                  setWorkflowTouched(true);
                }}
                disabled={!workflows}
              >
                {!workflows && <option>Loading…</option>}
                {workflows?.map((w) => (
                  <option key={w.path} value={stem(w.file)}>
                    {w.name} ({w.file})
                  </option>
                ))}
              </select>
            )}
          </label>
        </div>
        <label className="lx-label">
          Title
          <input className="lx-input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Empty state on the Trending page" autoFocus={!noWorkspaces} />
        </label>
        <label className="lx-label">
          <span>
            Description <small>optional</small>
          </span>
          <textarea className="lx-field" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What should happen, and how you’ll know it’s done" />
        </label>
        <div className="lx-row2">
          <label className="lx-label">
            <span>
              Linear ref <small>optional</small>
            </span>
            <input className="lx-input" value={ref} onChange={(e) => setRef(e.target.value)} placeholder="HUB-416" />
          </label>
          <label className="lx-label">
            <span>
              Priority <small>when slots are full</small>
            </span>
            <select className="lx-select" value={priority} onChange={(e) => setPriority(e.target.value)}>
              <option value="0">Normal</option>
              <option value="600">High: as if queued 10 min earlier</option>
              <option value="3600">Urgent: as if queued 1 h earlier</option>
            </select>
          </label>
          {where && (
            <label className="lx-label">
              <span>
                Base branch <small>{ws ? 'the workspace default' : 'optional'}</small>
              </span>
              <input className="lx-input lx-mono" value={baseBranch} onChange={(e) => setBaseBranch(e.target.value)} placeholder={ws?.baseBranch ?? 'what the repo has checked out'} />
            </label>
          )}
        </div>
        {ws && (
          <details className="ox-wswhere">
            <summary>Where it will work</summary>
            <dl>
              <dt>Repo</dt>
              <dd className="lx-mono">{shortPath(ws.repoPath)}</dd>
              <dt>Branch</dt>
              <dd className="lx-mono">orstra/&lt;task&gt; from {base}</dd>
              <dt>Agents start in</dt>
              <dd className="lx-mono">{ws.subdir || 'the repo root'}</dd>
              <dt>Setup</dt>
              <dd className="lx-mono">{[...ws.setup, ...ws.copyFiles.map((f) => `copy ${f}`)].join(' · ') || 'none'}</dd>
            </dl>
          </details>
        )}
        {error && (
          <div className="lx-error" style={{ margin: 0 }}>
            {error}
          </div>
        )}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
