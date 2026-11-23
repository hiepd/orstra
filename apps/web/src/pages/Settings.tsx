import { useEffect, useState } from 'react';
import { api, errorMessage, type AgentName, type AgentSettings, type Settings } from '../api';
import { shortPath } from '../components/GitPanel';
import { useLiveResource } from '../lib/live';
import { setThemeChoice, useTheme, type ThemeChoice } from '../lib/theme';

function Row({ label, help, value, mono, ok }: { label: string; help: string; value: string; mono?: boolean; ok?: boolean }) {
  return (
    <div className="ox-srow2">
      <div className="ox-sl">
        <div className="ox-lb">{label}</div>
        <div className="ox-hp">{help}</div>
      </div>
      <span className={mono ? 'ox-val lx-mono' : 'ox-val'} style={ok === undefined ? undefined : { color: ok ? 'var(--green-fg)' : 'var(--red-fg)' }} title={value}>
        {value}
      </span>
    </div>
  );
}

const THEMES: { id: ThemeChoice; label: string }[] = [
  { id: 'system', label: 'System' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
];

function AppearanceCard() {
  const { choice } = useTheme();
  return (
    <>
      <h2 className="ox-h2">Appearance</h2>
      <div className="ox-card">
        <div className="ox-srow2">
          <div className="ox-sl">
            <div className="ox-lb">Theme</div>
            <div className="ox-hp">System follows your OS. Saved in this browser.</div>
          </div>
          <div className="ox-seg" role="radiogroup" aria-label="Theme">
            {THEMES.map((t) => (
              <button key={t.id} type="button" role="radio" aria-checked={choice === t.id} className={choice === t.id ? 'ox-on' : undefined} onClick={() => setThemeChoice(t.id)}>
                {t.label}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div style={{ height: 26 }} />
    </>
  );
}


const MODEL_SUGGESTIONS: Record<AgentName, string[]> = { 'claude-code': ['opus', 'sonnet', 'haiku'], codex: [] };
const MODE_LABELS: Record<string, string> = { acceptEdits: 'Accept edits', auto: 'Auto', bypassPermissions: 'Bypass permissions', manual: 'Manual', dontAsk: 'Don’t ask', plan: 'Plan' };

function Field({ label, help, children }: { label: string; help: string; children: React.ReactNode }) {
  return (
    <div className="ox-srow2">
      <div className="ox-sl">
        <div className="ox-lb">{label}</div>
        <div className="ox-hp">{help}</div>
      </div>
      {children}
    </div>
  );
}

/** One agent: its status, plus the defaults used when a workflow step doesn't set its own. */
function AgentCard({ s, agent, onSaved }: { s: Settings; agent: Settings['agents'][number]; onSaved: () => void }) {
  const saved: AgentSettings = s.agentConfig[agent.id] ?? {};
  const [draft, setDraft] = useState<AgentSettings>(saved);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const savedKey = JSON.stringify(saved);
  useEffect(() => setDraft(saved), [savedKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const isClaude = agent.id === 'claude-code';
  const dirty = JSON.stringify(clean(draft)) !== savedKey;
  const hasAny = Object.keys(saved).length > 0;

  const save = async (next: AgentSettings) => {
    setBusy(true);
    setErr(null);
    try {
      await api.saveAgentSettings(agent.id, clean(next));
      onSaved();
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const listId = `models-${agent.id}`;
  return (
    <>
      <h2 className="ox-h2">{agent.name}</h2>
      <div className="ox-card">
        <Row
          label="Status"
          help={agent.path ? shortPath(agent.path) : `The “${agent.command}” command isn’t on the daemon’s PATH`}
          value={agent.path ? (isClaude ? 'Ready' : 'Installed · not wired up yet') : 'Not found'}
          ok={isClaude ? !!agent.path : undefined}
        />
        <Field label="Default model" help="Used when a step doesn’t set a model. Empty means the agent’s own default.">
          <input
            className="lx-input ox-ctl"
            aria-label={`${agent.name} default model`}
            list={listId}
            value={draft.model ?? ''}
            placeholder="Agent default"
            spellCheck={false}
            onChange={(e) => setDraft({ ...draft, model: e.target.value })}
            onKeyDown={(e) => e.key === 'Enter' && dirty && !busy && void save(draft)}
          />
          <datalist id={listId}>
            {MODEL_SUGGESTIONS[agent.id].map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </Field>
        {isClaude && (
          <>
            <Field label="Effort" help="How hard Claude thinks (--effort). Applies to every Claude Code session.">
              <select className="lx-select ox-ctl" aria-label="Claude Code effort" value={draft.effort ?? ''} onChange={(e) => setDraft({ ...draft, effort: e.target.value || undefined })}>
                <option value="">Agent default</option>
                {s.efforts.map((x) => (
                  <option key={x} value={x}>{x}</option>
                ))}
              </select>
            </Field>
            <Field label="Permission mode" help={`What steps may do without asking (--permission-mode). Empty uses ${s.envPermissionMode ?? 'acceptEdits'}${s.envPermissionMode ? ' from ORSTRA_CLAUDE_PERMISSION' : ''}.`}>
              <select className="lx-select ox-ctl" aria-label="Claude Code permission mode" value={draft.permissionMode ?? ''} onChange={(e) => setDraft({ ...draft, permissionMode: e.target.value || undefined })}>
                <option value="">Orstra default</option>
                {s.permissionModes.map((x) => (
                  <option key={x} value={x}>{MODE_LABELS[x] ?? x}</option>
                ))}
              </select>
            </Field>
          </>
        )}
        <div className="ox-srow2 ox-actions">
          {err && <span className="lx-error" style={{ marginRight: 'auto' }}>{err}</span>}
          <button type="button" className="lx-btn" disabled={busy || !hasAny} onClick={() => void save({})}>
            Reset to default
          </button>
          <button type="button" className="lx-btn lx-pri" disabled={busy || !dirty} onClick={() => void save(draft)}>
            Save
          </button>
        </div>
      </div>
      <div style={{ height: 26 }} />
    </>
  );
}

/** Drops blank fields so "empty" and "unset" are the same thing. */
function clean(a: AgentSettings): AgentSettings {
  const out: AgentSettings = {};
  if (a.model?.trim()) out.model = a.model.trim();
  if (a.effort) out.effort = a.effort;
  if (a.permissionMode) out.permissionMode = a.permissionMode;
  return out;
}

/** How this machine runs Orstra. Read-only: these come from the daemon's environment. */
export function SettingsPage() {
  const res = useLiveResource('settings', api.settings, () => false);
  const s = res.data;
  return (
    <>
      <div className="lx-bar">
        <span className="lx-crumb">
          <b>Settings</b>
        </span>
      </div>
      <div className="ox-smain">
        <div className="ox-sdoc">
          {res.error && <div className="lx-error">{res.error}</div>}
          {res.loading && !s && !res.error && (
            <div className="lx-loading">
              <span className="lx-spin" /> Loading…
            </div>
          )}
          {s && (
            <>
              <AppearanceCard />
              {s.agents.map((a) => (
                <AgentCard key={a.id} s={s} agent={a} onSaved={res.reload} />
              ))}
              <div className="lx-hint" style={{ margin: '-14px 0 26px' }}>
                Agents run with your own setup: your skills, hooks and MCP servers. A model set on a workflow step wins over the default here. Saved in ~/.orstra/agents.json. Codex steps aren’t supported yet, so its settings take effect once they are.
              </div>

              <h2 className="ox-h2">Runner</h2>
              <div className="ox-card">
                <Row label="Slots" help="Agent and check runs that can work at the same time. Set with ORSTRA_SLOTS." value={String(s.slots)} />
                <Row label="Port" help="Where the daemon and this UI are served. Set with ORSTRA_PORT." value={String(s.port)} />
              </div>

              <h2 className="ox-h2" style={{ marginTop: 26 }}>
                Files
              </h2>
              <div className="ox-card">
                {s.workflowDirs.map((d) => (
                  <Row key={d} label="Workflows folder" help="YAML files here show up under Workflows" value={shortPath(d)} mono />
                ))}
                <Row label="Worktrees" help="One folder per task, on its own branch" value={shortPath(s.worktrees)} mono />
                <Row label="Database" help="Tasks, runs and events (SQLite)" value={shortPath(s.database)} mono />
                <Row label="Home" help="Everything Orstra stores. Set with ORSTRA_HOME." value={shortPath(s.home)} mono />
              </div>
              <div className="lx-hint" style={{ marginTop: 8 }}>
                Read-only for now. Triggers, repositories, connections and notifications aren’t built yet; tasks are started by hand from Tasks or with “orstra run”.
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}
