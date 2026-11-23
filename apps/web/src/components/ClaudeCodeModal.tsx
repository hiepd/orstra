import type { RunView } from '../api';
import { Modal, useToast } from './Overlay';

/** Shows the terminal command that resumes (or forks, for ended runs) a run's Claude Code session. */
export function ClaudeCodeModal({ run, crumb, onClose }: { run: RunView; crumb: string; onClose: () => void }) {
  const toast = useToast();
  const ended = run.status !== 'running' && run.status !== 'queued' && run.status !== 'waiting';
  const cmd = ended ? run.forkCommand ?? run.openCommand : run.openCommand;
  const copy = async () => {
    if (!cmd) return;
    try {
      await navigator.clipboard.writeText(cmd);
      toast('Command copied. Paste it in your terminal.');
      onClose();
    } catch {
      toast('Couldn’t copy. Select the command and copy it by hand.', { error: true });
    }
  };
  return (
    <Modal
      crumb={
        <>
          <span>{crumb}</span>
          <span>›</span>
          <span>Open in Claude Code</span>
        </>
      }
      title={ended ? 'Open a copy of this session in Claude Code' : 'Open this session in Claude Code'}
      onClose={onClose}
      footer={
        <>
          <button className="lx-btn" onClick={onClose}>
            Cancel
          </button>
          <button className="lx-btn lx-pri" onClick={copy} disabled={!cmd}>
            Copy command
          </button>
        </>
      }
    >
      <p>
        {ended
          ? 'This run has ended. The command forks its session, so you can keep talking to it without changing what it recorded.'
          : 'Run this in your terminal to resume the same session the run is using. Orstra records your messages in the task.'}
      </p>
      {cmd ? (
        <div className="lx-cmd">
          <code>$ {cmd}</code>
          <button onClick={copy}>Copy</button>
        </div>
      ) : (
        <p className="lx-hint">This run has no Claude Code session yet.</p>
      )}
    </Modal>
  );
}
