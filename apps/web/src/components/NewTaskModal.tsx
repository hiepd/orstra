import { useEffect, useState, type FormEvent } from 'react';
import { api, errorMessage, type WorkflowInfo } from '../api';
import { href, navigate } from '../lib/router';
import { Modal, useToast } from './Overlay';

const stem = (file: string) => file.replace(/\.ya?ml$/, '');

export function NewTaskModal({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [workflows, setWorkflows] = useState<WorkflowInfo[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [workflow, setWorkflow] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [ref, setRef] = useState('');
  const [repo, setRepo] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .workflows()
      .then((ws) => {
        setWorkflows(ws);
        if (ws.length) setWorkflow(stem(ws[0].file));
      })
      .catch((err: unknown) => setLoadError(errorMessage(err)));
  }, []);

  const canSubmit = !!workflow && !!title.trim() && !busy;
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
        repo: repo.trim() || undefined,
      });
      toast('Task started');
      onClose();
      navigate(href.task(task.id));
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <Modal
      crumb={<span>New task</span>}
      title="Start a task"
      onClose={onClose}
      width={560}
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
        <label className="lx-label">
          Workflow
          {loadError ? (
            <span className="lx-error" style={{ margin: 0 }}>
              {loadError}
            </span>
          ) : workflows && workflows.length === 0 ? (
            <span className="lx-hint">No workflows found. Add a YAML file to the workflows folder.</span>
          ) : (
            <select className="lx-select" value={workflow} onChange={(e) => setWorkflow(e.target.value)} disabled={!workflows}>
              {!workflows && <option>Loading…</option>}
              {workflows?.map((w) => (
                <option key={w.path} value={stem(w.file)}>
                  {w.name} ({w.file})
                </option>
              ))}
            </select>
          )}
        </label>
        <label className="lx-label">
          Title
          <input className="lx-input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Empty state on the Trending page" autoFocus />
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
              Repo path <small>optional</small>
            </span>
            <input className="lx-input lx-mono" value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="~/workspace/hub" />
          </label>
        </div>
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
