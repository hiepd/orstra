import type { Settings } from '../../api';
import { SettingsCard, SettingsValue } from '../../components/SettingsRow';

/** How much the daemon runs at once, and where it is served. Read-only: it comes from the
 *  daemon's environment. */
export function RunnerGroup({ s }: { s: Settings }) {
  return (
    <SettingsCard>
      <SettingsValue label="Slots" help="Agent and check runs that can work at the same time. Set with ORSTRA_SLOTS." value={String(s.slots)} />
      <SettingsValue label="Port" help="Where the daemon and this UI are served. Set with ORSTRA_PORT." value={String(s.port)} />
    </SettingsCard>
  );
}
