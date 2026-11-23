import { useCallback, useState } from 'react';
import { api, type SessionView } from '../api';
import { ClaudeCodeModal } from '../components/ClaudeCodeModal';
import { ChevronRight, PlusIcon, TerminalIcon } from '../components/Icons';
import { RunPeek } from '../components/RunPeek';
import { AgentAvatar, RunStatusIcon } from '../components/Status';
import { taskLabel } from '../lib/format';
import { useLiveResource, useNow } from '../lib/live';
import { age, duration } from '../lib/time';

type GroupKey = 'running' | 'queued' | 'ended';
const GROUPS: { key: GroupKey; name: string; test: (s: SessionView) => boolean }[] = [
  { key: 'running', name: 'Running now', test: (s) => s.status === 'running' || s.status === 'waiting' },
  { key: 'queued', name: 'Queued', test: (s) => s.status === 'queued' },
  { key: 'ended', name: 'Ended in the last 24 hours', test: (s) => s.status === 'done' || s.status === 'failed' || s.status === 'stopped' },
];

function nowText(s: SessionView): string {
  if (s.status === 'queued') return 'Starts when a slot frees up';
  if (s.status === 'waiting') return s.now ?? 'Waiting for your reply';
  if (s.status === 'running') return s.now ?? (s.kind === 'gate' ? 'Running checks' : 'Starting…');
  const how = s.status === 'stopped' ? 'stopped' : s.outcome ?? s.status;
  return `Ended · ${how.replace(/_/g, ' ')}`;
}

export function SessionsPage({ onNewTask }: { onNewTask: () => void }) {
  const now = useNow(1000);
  const res = useLiveResource('sessions', api.sessions);
  const [collapsed, setCollapsed] = useState<Record<GroupKey, boolean>>({ running: false, queued: false, ended: true });
  const [selId, setSelId] = useState<string | null>(null);
  const [ccId, setCcId] = useState<string | null>(null);
  const closePeek = useCallback(() => setSelId(null), []);

  const sessions = res.data ?? [];
  const sel = sessions.find((s) => s.id === selId) ?? null;
  const cc = sessions.find((s) => s.id === ccId) ?? null;
  const running = sessions.filter((s) => s.status === 'running').length;
  const queued = sessions.filter((s) => s.status === 'queued').length;
  const waiting = sessions.filter((s) => s.status === 'waiting').length;
  const groups = GROUPS.map((g) => ({ ...g, rows: sessions.filter(g.test).sort((a, b) => (b.startedAt ?? b.createdAt) - (a.startedAt ?? a.createdAt)) })).filter((g) => g.rows.length > 0);
  const nothingActive = running === 0 && queued === 0 && waiting === 0;

  return (
    <>
      <div className="lx-bar">
        <span className="lx-crumb">
          <b>Sessions</b>
        </span>
        <span className="lx-muted">
          {running} running{waiting ? ` · ${waiting} waiting for you` : ''} · {queued} queued
        </span>
      </div>
      <div className="lx-body">
        {res.error && !res.data && <div className="lx-error">{res.error}</div>}
        {res.loading && !res.data && !res.error && (
          <div className="lx-loading">
            <span className="lx-spin" /> Loading sessions…
          </div>
        )}
        {res.data && nothingActive && (
          <div className="lx-empty">
            <TerminalIcon size={28} stroke="#B4B5BD" strokeWidth={1.6} />
            <b>No agents running</b>
            <span>Start a task and its sessions show up here.</span>
            <button className="lx-btn lx-pri" onClick={onNewTask}>
              <PlusIcon />
              New task
            </button>
          </div>
        )}
        {groups.map((g) => {
          const open = !collapsed[g.key];
          return (
            <div key={g.key}>
              <button className="lx-gh" onClick={() => setCollapsed((c) => ({ ...c, [g.key]: open }))} aria-expanded={open}>
                <ChevronRight open={open} />
                {g.name}
                <span>{g.rows.length}</span>
              </button>
              {open &&
                g.rows.map((s) => (
                  <SessionRow key={s.id} s={s} now={now} selected={s.id === selId} onOpen={() => setSelId(s.id)} onCC={() => setCcId(s.id)} />
                ))}
            </div>
          );
        })}
      </div>
      {sel && <RunPeek run={sel} task={sel.task} onClose={closePeek} onOpenCC={() => setCcId(sel.id)} />}
      {cc && <ClaudeCodeModal run={cc} crumb={taskLabel(cc.task)} onClose={() => setCcId(null)} />}
    </>
  );
}

function SessionRow({ s, now, selected, onOpen, onCC }: { s: SessionView; now: number; selected: boolean; onOpen: () => void; onCC: () => void }) {
  const ended = s.status !== 'running' && s.status !== 'queued' && s.status !== 'waiting';
  const time = s.status === 'running' || s.status === 'waiting' ? duration(s.startedAt, now) : s.status === 'queued' ? '—' : age(s.endedAt, now);
  const canCC = s.kind === 'agent' && !!s.sessionId && s.status !== 'queued';
  return (
    <div className={`lx-srow${selected ? ' lx-sel' : ''}`}>
      <button className="lx-rowmain" onClick={onOpen} aria-label={`Open ${taskLabel(s.task)} ${s.stepTitle}`}>
        {s.status === 'running' ? <span className="lx-spin" aria-label="Running" /> : <RunStatusIcon status={s.status} outcome={s.outcome} />}
        <AgentAvatar run={s} large />
        <span className="lx-id" title={s.task.ref ?? s.task.id}>
          {taskLabel(s.task)}
        </span>
        <span className="lx-step">
          {s.stepTitle}
          {s.attempt > 1 && <small> · attempt {s.attempt}</small>}
        </span>
        <span className="lx-task">{s.task.title}</span>
        <span className="lx-now" title={nowText(s)}>
          {nowText(s)}
        </span>
        {s.status === 'waiting' && <span className="lx-pill lx-purple">Waiting for you</span>}
        <span className="lx-time" title={ended ? 'Ended' : s.status === 'running' ? 'Running for' : undefined}>
          {time}
        </span>
      </button>
      {canCC && (
        <button className="lx-cc" onClick={onCC}>
          <TerminalIcon size={12} strokeWidth={2.2} />
          {ended ? 'Open a copy' : 'Claude Code'}
        </button>
      )}
    </div>
  );
}
