import { api, type ChatFile } from '../api';
import { Composer } from './Composer';

/**
 * The message box for one agent session. It is the shared `Composer` with what a task adds: the
 * branch the session works on, the states of a run, and stop for the run the task is on.
 */
export function ChatBox({
  taskId,
  runId,
  working,
  canStop,
  waiting,
  reopened,
  sendsBack,
  stepTitle,
  who,
  av,
  color,
  branch,
}: {
  taskId: string;
  runId: string;
  /** The agent is in the middle of a turn. */
  working: boolean;
  /** Stop is offered only for the run the task is on. */
  canStop: boolean;
  /** The agent is waiting for your reply. */
  waiting: boolean;
  /** An ended session you reopened: talking here doesn't move the task. */
  reopened: boolean;
  /** The run ended, but the task is open: your message sends it back to this step. */
  sendsBack?: boolean;
  stepTitle?: string;
  who: string;
  av: string;
  color: string;
  branch: string | null;
}) {
  const placeholder = waiting
    ? `Reply to ${who}…`
    : working
      ? `Message ${who}. It reads this after its current action.`
      : sendsBack
        ? `Message ${who}. ${stepTitle ?? 'This step'} takes the task back.`
        : reopened
          ? 'Ask about this session. The task doesn’t move.'
          : `Message ${who}…`;
  const status = working ? 'working' : waiting ? 'waiting for you' : sendsBack ? 'sends the task back' : reopened ? 'reopened; doesn’t move the task' : '';

  return (
    <Composer
      to={{ kind: 'task', taskId }}
      who={who}
      av={av}
      color={color}
      placeholder={placeholder}
      status={status}
      working={working}
      canStop={canStop}
      focusWhen={waiting}
      acceptsInserts
      context={
        branch ? (
          <span className="ox-cctx ox-cbranch" title="The branch this session works on">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="6" cy="5" r="2.5" />
              <circle cx="6" cy="19" r="2.5" />
              <circle cx="18" cy="8" r="2.5" />
              <path d="M6 7.5v9M18 10.5c0 4-6 3-12 6" />
            </svg>
            {branch}
          </span>
        ) : null
      }
      onSend={(text: string, files: ChatFile[]) => api.message(taskId, { text, mode: 'chat', runId, files: files.length ? files : undefined }).then(() => undefined)}
      onStop={() => api.interrupt(taskId).then(() => undefined)}
    />
  );
}
