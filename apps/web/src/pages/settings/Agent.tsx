import { useEffect, useState } from 'react';
import { api, errorMessage, type AgentName, type AgentSettings, type Settings } from '../../api';
import { shortPath } from '../../components/GitPanel';
import { SettingsCard, SettingsRow, SettingsValue } from '../../components/SettingsRow';

const MODEL_SUGGESTIONS: Record<AgentName, string[]> = { 'claude-code': ['opus', 'sonnet', 'haiku'], codex: [] };
const MODE_LABELS: Record<string, string> = { acceptEdits: 'Accept edits', auto: 'Auto', bypassPermissions: 'Bypass permissions', manual: 'Manual', dontAsk: 'Don’t ask', plan: 'Plan' };

/** Drops blank fields so "empty" and "unset" are the same thing. */
function clean(a: AgentSettings): AgentSettings {
  const out: AgentSettings = {};
  if (a.model?.trim()) out.model = a.model.trim();
  if (a.effort) out.effort = a.effort;
  if (a.permissionMode) out.permissionMode = a.permissionMode;
  if (a.askPermission === false) out.askPermission = false;
  if (a.artifact === false) out.artifact = false;
  return out;
}

/** One agent: its status, plus the defaults used when a workflow step doesn't set its own. */
export function AgentGroup({ s, agent, onSaved }: { s: Settings; agent: Settings['agents'][number]; onSaved: () => void }) {
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
    <SettingsCard
      note={
        <>
          Agents run with your own setup: your skills, hooks and MCP servers. A model set on a workflow step wins over the default here. Saved in ~/.orstra/agents.json.
          {!isClaude && ' Codex steps run with codex exec in a workspace-write sandbox (ORSTRA_CODEX_SANDBOX).'}
        </>
      }
    >
      <SettingsValue
        label="Status"
        help={agent.path ? shortPath(agent.path) : `The “${agent.command}” command isn’t on the daemon’s PATH`}
        value={agent.path ? 'Ready' : 'Not found'}
        ok={!!agent.path}
      />
      <SettingsRow label="Default model" help="Used when a step doesn’t set a model. Empty means the agent’s own default.">
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
      </SettingsRow>
      {isClaude && (
        <>
          <SettingsRow label="Effort" help="How hard Claude thinks (--effort). Applies to every Claude Code session.">
            <select className="lx-select ox-ctl" aria-label="Claude Code effort" value={draft.effort ?? ''} onChange={(e) => setDraft({ ...draft, effort: e.target.value || undefined })}>
              <option value="">Agent default</option>
              {s.efforts.map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </select>
          </SettingsRow>
          <SettingsRow label="Permission mode" help={`What steps may do without asking (--permission-mode). Empty uses ${s.envPermissionMode ?? 'acceptEdits'}${s.envPermissionMode ? ' from ORSTRA_CLAUDE_PERMISSION' : ''}.`}>
            <select className="lx-select ox-ctl" aria-label="Claude Code permission mode" value={draft.permissionMode ?? ''} onChange={(e) => setDraft({ ...draft, permissionMode: e.target.value || undefined })}>
              <option value="">Orstra default</option>
              {s.permissionModes.map((x) => (
                <option key={x} value={x}>
                  {MODE_LABELS[x] ?? x}
                </option>
              ))}
            </select>
          </SettingsRow>
          <SettingsRow label="Ask for permission" help="On: a tool the permission mode does not allow comes to your Inbox as a question. Off: Claude Code refuses it.">
            <input
              type="checkbox"
              aria-label="Ask for permission in the Inbox"
              checked={draft.askPermission !== false}
              onChange={(e) => setDraft({ ...draft, askPermission: e.target.checked ? undefined : false })}
            />
          </SettingsRow>
          <SettingsRow label="Publish artifacts" help="On: a step's agent can publish a Claude artifact, a page on your claude.ai account. Off (or ORSTRA_CLAUDE_ARTIFACT=0): the Artifact tool stays off.">
            <input
              type="checkbox"
              aria-label="Let a step's agent publish a Claude artifact"
              checked={draft.artifact !== false}
              onChange={(e) => setDraft({ ...draft, artifact: e.target.checked ? undefined : false })}
            />
          </SettingsRow>
        </>
      )}
      <div className="ox-srow2 ox-actions">
        {err && (
          <span className="lx-error" style={{ marginRight: 'auto' }}>
            {err}
          </span>
        )}
        <button type="button" className="lx-btn" disabled={busy || !hasAny} onClick={() => void save({})}>
          Reset to default
        </button>
        <button type="button" className="lx-btn lx-pri" disabled={busy || !dirty} onClick={() => void save(draft)}>
          Save
        </button>
      </div>
    </SettingsCard>
  );
}
