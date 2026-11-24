import type { Settings } from '../../api';
import { SettingsCard, SettingsValue } from '../../components/SettingsRow';
import { money } from '../../lib/format';
import { ago } from '../../lib/time';

/** The triggers the workflow files list, and how their last check went. Read-only: edit the workflows. */
export function TriggersGroup({ s }: { s: Settings }) {
  const list = s.triggers ?? [];
  return (
    <>
      <SettingsCard note="Set LINEAR_API_KEY in the daemon’s environment for Linear triggers. Orstra checks every trigger once a minute (ORSTRA_TRIGGER_INTERVAL_S).">
        <SettingsValue label="Linear" help="A personal API key from Linear, in LINEAR_API_KEY." value={s.linear ? 'Connected' : 'No API key'} ok={!!s.linear} />
      </SettingsCard>
      <SettingsCard
        title="Triggers in your workflows"
        note={
          <>
            Add one to a workflow file, for example <code>triggers: [{'{'} linear: {'{'} label: agent-ready {'}'} {'}'}]</code> or{' '}
            <code>
              [{'{'} schedule: {'{'} every: 1d, title: Triage {'}'} {'}'}]
            </code>
            .
          </>
        }
      >
        {list.length === 0 ? (
          <SettingsValue label="None yet" help="No workflow file lists a trigger." value="—" />
        ) : (
          list.map((t) => (
            <SettingsValue
              key={`${t.workflow}:${t.label}`}
              label={t.label}
              help={t.lastError ? `${t.workflow} · ${t.lastError}` : `${t.workflow} · checked ${t.lastCheck ? ago(t.lastCheck) : 'not yet'}`}
              value={t.lastError ? 'Error' : `${t.started} started`}
              ok={!t.lastError}
            />
          ))
        )}
      </SettingsCard>
    </>
  );
}

/** What agent runs cost. The numbers are Claude Code's own estimates; Codex reports tokens only. */
export function UsageGroup({ s }: { s: Settings }) {
  return (
    <SettingsCard note="Claude Code’s own estimate of cost, not your bill. Set budget_usd in a workflow to stop a task’s agent work at that amount.">
      <SettingsValue label="Today" help="Every run since midnight." value={money(s.cost?.today)} />
      <SettingsValue label="Last 7 days" help="Every run in the last 7 days." value={money(s.cost?.week)} />
    </SettingsCard>
  );
}
