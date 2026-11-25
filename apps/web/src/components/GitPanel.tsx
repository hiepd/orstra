import { useCallback, useState } from 'react';
import { api, type Check, type GitView, type TaskDetail } from '../api';
import { useLiveResource, type Resource } from '../lib/live';
import { ArtifactList } from './Artifacts';
import { ago } from '../lib/time';
import { useToast } from './Overlay';

export const shortPath = (p: string) => p.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~');

/** The task's worktree, refetched (at most every 1.5s) while the task changes. */
export function useGit(taskId: string): Resource<GitView> {
  return useLiveResource(`git:${taskId}`, useCallback(() => api.git(taskId), [taskId]), (id) => id === taskId, 1500);
}

type Tab = 'changes' | 'checks' | 'artifacts' | 'commits';

const CHECK: Record<Check['state'], { color: string; label: string; path: string }> = {
  pass: { color: 'var(--green-fg)', label: 'Passed', path: 'm4.2 7.2 1.9 1.9 3.8-4' },
  fail: { color: 'var(--red)', label: 'Failed', path: 'm4.8 4.8 4.4 4.4M9.2 4.8 4.8 9.2' },
  running: { color: '#3B82F6', label: 'Running', path: 'M5.4 4.6v4.8l4-2.4z' },
  stopped: { color: 'var(--dim)', label: 'Stopped', path: 'M4.5 7h5' },
};

/**
 * The side viewer's Changes panel: where the work lives (worktree, branch, PR) and what it changed
 * (files with diffs, checks, commits).
 */
export function GitBody({ task, git, openPath, onOpenPath }: { task: TaskDetail; git: Resource<GitView>; openPath: string | null; onOpenPath: (path: string | null) => void }) {
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('changes');
  const g = git.data;

  if (!task.worktree) {
    return (
      <div className="vw-git">
        <div className="ox-gempty">No worktree yet. Orstra creates one, on its own branch, when the task starts.</div>
      </div>
    );
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(task.worktree ?? '');
      toast('Worktree path copied');
    } catch {
      toast('Couldn’t copy to the clipboard', { error: true });
    }
  };
  const file = openPath ? g?.files.find((f) => f.path === openPath) : undefined;
  const status = g
    ? [g.ahead ? `${g.ahead} ${g.ahead === 1 ? 'commit' : 'commits'}${g.base ? ` ahead of ${g.base}` : ''}` : '', g.uncommitted ? `${g.uncommitted} uncommitted` : ''].filter(Boolean).join(' · ') || 'No changes yet'
    : '…';

  return (
    <div className="vw-git">
      <div className="ox-gitc">
        <div className="ox-grow">
          <span className="ox-gk">Worktree</span>
          <span className="ox-gv" title={task.worktree}>
            {shortPath(task.worktree)}
          </span>
          <button className="ox-gbtn" onClick={() => void copy()}>
            Copy
          </button>
        </div>
        <div className="ox-grow">
          <span className="ox-gk">Branch</span>
          <span className="ox-gv" title={g?.branch ?? ''}>
            {g?.branch ?? '…'}
            {g?.base ? ` → ${g.base}` : ''}
          </span>
        </div>
        <div className="ox-grow">
          <span className="ox-gk">Status</span>
          <span className="ox-gvp">{status}</span>
        </div>
        <div className="ox-grow">
          <span className="ox-gk">PR</span>
          {g?.pr ? (
            <a className="ox-gvp" href={g.pr.url} target="_blank" rel="noreferrer">
              {prName(g.pr.url)}
            </a>
          ) : (
            <span className="ox-gvp" style={{ color: 'var(--faint)' }}>
              Not opened yet
            </span>
          )}
        </div>
      </div>
      <div className="ox-gtabs" role="group" aria-label="Worktree panel">
        {(['changes', 'checks', 'artifacts', 'commits'] as Tab[]).map((t) => (
          <button key={t} className="ox-tab" aria-pressed={tab === t} onClick={() => setTab(t)}>
            {t === 'changes'
              ? `Changes ${g?.files.length ?? ''}`
              : t === 'checks'
                ? `Checks ${g?.checks.length ?? ''}`
                : t === 'artifacts'
                  ? `Artifacts ${g?.artifacts.length ?? ''}`
                  : `Commits ${g?.commits.length ?? ''}`}
          </button>
        ))}
      </div>
      <div className="ox-gbody">
        {git.error && !g && <div className="ox-gempty">Couldn’t read the worktree: {git.error}</div>}
        {g && tab === 'changes' && !openPath && (
          <>
            {g.files.map((f) => (
              <button key={f.path} className="ox-crow" onClick={() => onOpenPath(f.path)} title={f.uncommitted ? `${f.path} (not committed yet)` : f.path}>
                <span className={`ox-fs ox-fs-${f.status}`}>{f.status}</span>
                <span className="ox-fpath">
                  <bdi>{f.path}</bdi>
                </span>
                {f.uncommitted && <span className="ox-unc" aria-label="Not committed yet" />}
                <span className="ox-add">+{f.add}</span>
                <span className="ox-del">−{f.del}</span>
              </button>
            ))}
            {g.files.length === 0 ? (
              <div className="ox-gempty">No changes yet. Files the agent edits in this worktree show up here.</div>
            ) : (
              <div className="lx-hint" style={{ padding: '10px 14px' }}>
                {g.base ? `Compared with ${g.base}, where this branch started.` : 'Everything in this task’s own folder.'} A dot marks files not committed yet.
              </div>
            )}
          </>
        )}
        {g && tab === 'changes' && openPath && <DiffView taskId={task.id} path={openPath} add={file?.add} del={file?.del} stamp={`${g.ahead}:${g.uncommitted}:${file?.add}:${file?.del}`} onBack={() => onOpenPath(null)} />}
        {g && tab === 'checks' && (
          <>
            {g.checks.map((c) => (
              <div key={c.runId} className="ox-chk">
                <svg width="14" height="14" viewBox="0 0 14 14" style={{ flex: 'none', marginTop: 2 }} role="img" aria-label={CHECK[c.state].label}>
                  <circle cx="7" cy="7" r="6.5" fill={CHECK[c.state].color} />
                  <path d={CHECK[c.state].path} fill="none" stroke="#FFFFFF" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="ox-chkn">
                    {c.name}
                    <span className="ox-muted" style={{ fontFamily: 'inherit' }}>
                      {' '}
                      · {CHECK[c.state].label.toLowerCase()}
                      {c.endedAt ? ` ${ago(c.endedAt)}` : ''}
                    </span>
                  </div>
                  {c.detail && <pre className="ox-pre ox-chkd">{c.detail}</pre>}
                </div>
              </div>
            ))}
            {g.checks.length === 0 && <div className="ox-gempty">No checks have run yet. Gate steps (tests, typecheck) show up here.</div>}
          </>
        )}
        {g && tab === 'artifacts' && <ArtifactList artifacts={g.artifacts} />}
        {g && tab === 'commits' && (
          <>
            {g.commits.map((c) => (
              <div key={c.sha} className="ox-cmt">
                <span className="ox-gv" style={{ color: 'var(--muted)' }}>
                  {c.sha}
                </span>
                <span className="ox-trunc" title={c.message}>
                  {c.message}
                </span>
                <span className="ox-muted">{ago(c.ts)}</span>
              </div>
            ))}
            {g.commits.length === 0 && <div className="ox-gempty">No commits yet.</div>}
          </>
        )}
      </div>
    </div>
  );
}

type Line = { cls: string; n: string; text: string };

function parseDiff(diff: string): Line[] {
  const out: Line[] = [];
  let n = 0;
  let inHunk = false;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('@@')) {
      const m = /\+(\d+)/.exec(raw);
      n = m ? parseInt(m[1], 10) - 1 : 0;
      inHunk = true;
      out.push({ cls: 'ox-dl ox-dhunk', n: '', text: raw });
      continue;
    }
    if (!inHunk) continue; // file headers: "diff --git", "index", "---", "+++"
    if (raw.startsWith('\\')) continue; // "\ No newline at end of file"
    const ch = raw.charAt(0);
    if (ch !== '-') n++;
    out.push({ cls: `ox-dl${ch === '+' ? ' ox-dadd' : ch === '-' ? ' ox-ddel' : ''}`, n: ch === '-' ? '' : String(n), text: raw });
  }
  if (out.length && out[out.length - 1].text === '') out.pop();
  return out;
}

function DiffView({ taskId, path, add, del, stamp, onBack }: { taskId: string; path: string; add?: number; del?: number; stamp: string; onBack: () => void }) {
  // `stamp` changes when the worktree does, so the diff refetches while the agent keeps editing.
  const res = useLiveResource(`diff:${taskId}:${path}:${stamp}`, useCallback(() => api.diff(taskId, path), [taskId, path]), () => false);
  const lines = res.data ? parseDiff(res.data.diff) : [];
  return (
    <>
      <div className="ox-dhead">
        <button className="lx-ib" aria-label="Back to changed files" onClick={onBack}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m15 6-6 6 6 6" />
          </svg>
        </button>
        <span className="ox-fpath" style={{ fontWeight: 500 }} title={path}>
          <bdi>{path}</bdi>
        </span>
        {add !== undefined && <span className="ox-add">+{add}</span>}
        {del !== undefined && <span className="ox-del">−{del}</span>}
      </div>
      {res.error && <div className="ox-gempty">Couldn’t load this diff: {res.error}</div>}
      {res.loading && !res.data && !res.error && <div className="ox-gempty">Loading…</div>}
      {res.data && lines.length === 0 && <div className="ox-gempty">No text changes to show (the file may be binary or unchanged).</div>}
      {lines.length > 0 && (
        <div className="ox-diff">
          {lines.map((l, i) => (
            <div key={i} className={l.cls}>
              <span className="ox-dn">{l.n}</span>
              <span className="ox-dt">{l.text || ' '}</span>
            </div>
          ))}
          {res.data?.truncated && <div className="ox-gempty">This diff is long; only the first part is shown.</div>}
        </div>
      )}
    </>
  );
}

/** "#123" from a pull request URL, else the URL. */
export function prName(url: string): string {
  const m = url.match(/\/pull\/(\d+)/);
  return m ? `#${m[1]}` : url;
}
