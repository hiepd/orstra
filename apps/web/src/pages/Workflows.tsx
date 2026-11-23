import { useCallback, useState } from 'react';
import { api, type WorkflowStep } from '../api';
import { shortPath } from '../components/GitPanel';
import { WorkflowsIcon } from '../components/Icons';
import { WorkflowEditor } from '../components/WorkflowEditor';
import { AGENTS, humanize } from '../lib/format';
import { useLiveResource } from '../lib/live';
import { href, navigate } from '../lib/router';
import { KIND } from '../lib/stepKinds';

function what(s: WorkflowStep): string {
  if (s.kind === 'agent') return `${AGENTS[s.agent ?? 'claude-code'].name}${s.model ? ` · ${s.model}` : ''}`;
  if (s.kind === 'gate') return (s.run ?? []).join(' && ');
  if (s.kind === 'human') return s.question ?? 'Waits for you';
  if (s.kind === 'action') return s.action ?? '';
  return '';
}

/** The workflow files on this machine: each one's steps and arrows, and its YAML. Read-only for now. */
export function WorkflowsPage({ file }: { file?: string }) {
  const list = useLiveResource('workflows', api.workflows, () => false);
  const sel = file ?? list.data?.[0]?.file;
  const wf = useLiveResource(`workflow:${sel ?? ''}`, useCallback(() => (sel ? api.workflow(sel) : Promise.resolve(null)), [sel]), () => false);
  const [tab, setTab] = useState<'steps' | 'canvas' | 'yaml'>('canvas');
  const w = wf.data;

  return (
    <>
      <div className="lx-bar">
        <div className="lx-crumb">
          <span>Workflows</span>
          {w && (
            <>
              <span>›</span>
              <b>{w.name}</b>
            </>
          )}
        </div>
        {w && (
          <>
          {tab === 'canvas' && (list.data?.length ?? 0) > 1 && sel && (
            <select className="wf-pick" aria-label="Workflow" value={sel} onChange={(e) => navigate(href.workflow(e.target.value))}>
              {(list.data ?? []).map((x) => (
                <option key={x.path} value={x.file}>
                  {x.name}
                </option>
              ))}
            </select>
          )}
          <div className="ox-seg" role="group" aria-label="Workflow view" style={{ marginLeft: 10 }}>
            <button aria-pressed={tab === 'canvas'} onClick={() => setTab('canvas')}>
              Canvas
            </button>
            <button aria-pressed={tab === 'steps'} onClick={() => setTab('steps')}>
              Steps
            </button>
            <button aria-pressed={tab === 'yaml'} onClick={() => setTab('yaml')}>
              YAML
            </button>
          </div>
          </>
        )}
      </div>
      <div className="ox-set">
        <nav className="ox-snav" aria-label="Workflows" style={{ flexBasis: 240, display: tab === 'canvas' && w && !w.error ? 'none' : undefined }}>
          {(list.data ?? []).map((x) => (
            <a key={x.path} className="ox-snb ox-wfitem" href={href.workflow(x.file)} aria-current={x.file === sel ? 'page' : undefined}>
              <span className="ox-trunc">{x.name}</span>
              <span className="ox-wffile">{x.file}</span>
            </a>
          ))}
          {list.data && list.data.length === 0 && <div className="lx-hint" style={{ padding: 8 }}>No workflow files found.</div>}
        </nav>
        {w && tab === 'canvas' && !w.error && (
          <div className="ox-smain wf-main">
            <WorkflowEditor key={w.path} detail={w} onSaved={wf.reload} />
          </div>
        )}
        <div className="ox-smain" style={w && tab === 'canvas' && !w.error ? { display: 'none' } : undefined}>
          <div className="ox-sdoc" style={{ maxWidth: 760 }}>
            {list.error && <div className="lx-error">{list.error}</div>}
            {!sel && list.data && (
              <div className="lx-empty">
                <span style={{ color: 'var(--dim)' }}>
                  <WorkflowsIcon />
                </span>
                <b>No workflows yet</b>
                <span>A workflow is a YAML file: a list of steps and the arrows between them.</span>
              </div>
            )}
            {w && (
              <>
                <h1 className="ox-h1" style={{ fontSize: 20 }}>
                  {w.name}
                </h1>
                {w.description && <div className="ox-sub">{w.description}</div>}
                <div className="ox-sub">
                  <span className="lx-mono">{shortPath(w.path)}</span>
                  {w.repo ? ` · repository ${shortPath(w.repo)}` : ' · no repository: each task gets its own scratch folder'}
                </div>
                {w.error && (
                  <div className="lx-error" style={{ marginTop: 16 }}>
                    This file doesn’t parse: {w.error}
                    {tab === 'canvas' && ' The canvas can’t open it. Fix the file in the YAML tab or your editor.'}
                  </div>
                )}

                {tab === 'steps' && !w.error && (
                  <div className="ox-wfsteps">
                    {w.steps.map((s) => (
                      <div key={s.id} className="ox-wfstep">
                        <div className="ox-wfh">
                          <span className="ox-oc" style={{ background: KIND[s.kind].bg, color: KIND[s.kind].fg }}>
                            {KIND[s.kind].label}
                          </span>
                          <b>{s.title}</b>
                          {s.id === w.start && <span className="ox-ukind">starts here</span>}
                          <span className="ox-wfwhat" title={what(s)}>
                            {what(s)}
                          </span>
                        </div>
                        {s.prompt && <div className="ox-wfprompt">{s.prompt.trim()}</div>}
                        <div className="ox-wfon">
                          {s.on.map((o) => (
                            <span key={o.outcome} className="ox-arrow">
                              <span className="ox-arrowk">{humanize(o.outcome).toLowerCase()}</span>→ {o.toTitle}
                              {o.max ? <span className="ox-ukind"> (at most {o.max}×)</span> : null}
                            </span>
                          ))}
                          <span className="ox-arrow ox-arrow-inbox">
                            <span className="ox-arrowk">anything else</span>→ your Inbox
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {tab === 'yaml' && <pre className="ox-pre ox-yaml">{w.yaml}</pre>}
                <div className="lx-hint" style={{ marginTop: 14 }}>
                  This view is read-only. Edit on the Canvas tab (Save writes to the YAML file), or edit the file in your editor.
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
