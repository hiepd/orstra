import type { Settings } from '../../api';
import { shortPath } from '../../components/GitPanel';
import { SettingsCard, SettingsValue } from '../../components/SettingsRow';

/** Where Orstra keeps everything on this machine. Read-only: these come from the daemon's
 *  environment. */
export function FilesGroup({ s }: { s: Settings }) {
  return (
    <SettingsCard note="Read-only for now. Triggers, repositories, connections and notifications aren’t built yet; tasks are started by hand from Tasks or with “orstra run”.">
      {s.workflowDirs.map((d) => (
        <SettingsValue key={d} label="Workflows folder" help="YAML files here show up under Workflows" value={shortPath(d)} mono />
      ))}
      <SettingsValue label="Worktrees" help="One folder per task, on its own branch" value={shortPath(s.worktrees)} mono />
      <SettingsValue label="Database" help="Tasks, runs and events (SQLite)" value={shortPath(s.database)} mono />
      <SettingsValue label="Home" help="Everything Orstra stores. Set with ORSTRA_HOME." value={shortPath(s.home)} mono />
    </SettingsCard>
  );
}
