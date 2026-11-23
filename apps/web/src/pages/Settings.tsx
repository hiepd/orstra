import { api } from '../api';
import { shortPath } from '../components/GitPanel';
import { useLiveResource } from '../lib/live';

function Row({ label, help, value, mono, ok }: { label: string; help: string; value: string; mono?: boolean; ok?: boolean }) {
  return (
    <div className="ox-srow2">
      <div className="ox-sl">
        <div className="ox-lb">{label}</div>
        <div className="ox-hp">{help}</div>
      </div>
      <span className={mono ? 'ox-val lx-mono' : 'ox-val'} style={ok === undefined ? undefined : { color: ok ? '#1A7F4B' : '#C4302B' }} title={value}>
        {value}
      </span>
    </div>
  );
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
              <h2 className="ox-h2">Agents</h2>
              <div className="ox-card">
                {s.agents.map((a) => (
                  <Row
                    key={a.id}
                    label={a.name}
                    help={a.path ? shortPath(a.path) : `The “${a.command}” command isn’t on the daemon’s PATH`}
                    value={a.path ? (a.id === 'codex' ? 'Installed · not wired up yet' : 'Ready') : 'Not found'}
                    ok={a.id === 'codex' ? undefined : !!a.path}
                  />
                ))}
              </div>
              <div className="lx-hint" style={{ margin: '8px 0 26px' }}>
                Agents run with your own setup: your skills, hooks and MCP servers. Codex steps aren’t supported yet.
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
