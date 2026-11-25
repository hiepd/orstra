import { api } from '../api';
import { SettingsCard, SettingsValue } from '../components/SettingsRow';
import { useLiveResource } from '../lib/live';
import { ago } from '../lib/time';

/**
 * What starts tasks on its own: the triggers the workflow files list, and how their last check went.
 * Read-only: edit the workflows. The daemon reports them with the settings, so this page reads those.
 */
export function TriggersPage() {
  const res = useLiveResource('settings', api.settings, () => false);
  const s = res.data;
  const list = s?.triggers ?? [];

  return (
    <>
      <div className="lx-bar">
        <div className="lx-crumb">
          <b>Triggers</b>
        </div>
      </div>
      <div className="ox-smain">
        <div className="ox-sdoc">
          <div className="ox-sghead">
            <h1 className="ox-h1">Triggers</h1>
            <div className="ox-sub">What starts tasks on its own: Linear issues and schedules.</div>
          </div>
          {res.error && <div className="lx-error">{res.error}</div>}
          {res.loading && !s && !res.error && (
            <div className="lx-loading">
              <span className="lx-spin" /> Loading…
            </div>
          )}
          {s && (
            <div className="ox-sgroup">
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
            </div>
          )}
        </div>
      </div>
    </>
  );
}
