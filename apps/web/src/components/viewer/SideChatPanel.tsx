import { api, type ChatFile } from '../../api';
import { agentOf } from '../../lib/format';
import { Composer } from '../Composer';
import { Markdown } from '../Markdown';
import type { PanelProps } from './Viewer';

/**
 * Ask a copy of the agent, beside the chat. The copy forks the session, so the run is not touched and
 * the task does not move. Your questions and its answers show here, not in the main chat.
 */
export function SideChatPanel({ task, runId }: PanelProps) {
  // TaskChat passes the session the chat shows (it picks the default one when you picked none).
  const run = task.runs.find((r) => r.id === runId && r.sessionId);
  if (!run) return <div className="vw-empty">No agent session yet. Side chat asks a copy of one, so it starts when the first agent step runs.</div>;
  const a = agentOf(run);
  const events = task.events.filter((e) => e.runId === run.id && (e.kind === 'aside' || (e.kind === 'you' && e.mode === 'ask')));
  const last = events[events.length - 1];
  const asking = last?.kind === 'you';

  return (
    <div className="vw-side">
      <div className="vw-scroll vw-sidel">
        <div className="vw-fhint">
          A copy of {a.name} answers here, from session {run.sessionId?.slice(0, 8)}. The run is not touched, and the task does not move.
        </div>
        {events.map((e) =>
          e.kind === 'you' ? (
            <div key={String(e.id)} className="ox-user">
              <div className="ox-bubble">{e.text}</div>
            </div>
          ) : e.kind === 'aside' ? (
            <div key={String(e.id)} className="ox-ai">
              <Markdown text={e.text} />
            </div>
          ) : null,
        )}
        {asking && <div className="vw-fhint ox-shine">The copy is thinking…</div>}
      </div>
      <div className="vw-sidec">
        <Composer
          to={{ kind: 'task', taskId: task.id }}
          who={`a copy of ${a.name}`}
          av={a.av}
          color={a.color}
          placeholder="Ask a copy…"
          status="side chat; doesn’t move the task"
          working={false}
          onSend={(text: string, files: ChatFile[]) => api.message(task.id, { text, mode: 'ask', runId: run.id, files: files.length ? files : undefined }).then(() => undefined)}
          onStop={() => Promise.resolve()}
        />
      </div>
    </div>
  );
}
