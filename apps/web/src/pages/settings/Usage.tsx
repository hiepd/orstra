import type { Settings } from '../../api';
import { SettingsCard, SettingsValue } from '../../components/SettingsRow';
import { money } from '../../lib/format';

/** What agent runs cost. The numbers are Claude Code's own estimates; Codex reports tokens only. */
export function UsageGroup({ s }: { s: Settings }) {
  return (
    <SettingsCard note="Claude Code’s own estimate of cost, not your bill. Set budget_usd in a workflow to stop a task’s agent work at that amount.">
      <SettingsValue label="Today" help="Every run since midnight." value={money(s.cost?.today)} />
      <SettingsValue label="Last 7 days" help="Every run in the last 7 days." value={money(s.cost?.week)} />
    </SettingsCard>
  );
}
