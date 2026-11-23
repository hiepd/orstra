import { Fragment, useState } from 'react';
import { api } from '../api';
import { useLiveResource } from '../lib/live';
import { href } from '../lib/router';
import { matchSettingsGroups, resolveSettingsGroup, settingsNav } from '../lib/settingsGroups';
import { settingsGroups } from './settings/groups';

/**
 * The Settings shell: a searchable nav of groups on the left, one group on the right. It
 * knows nothing about any individual group; the list comes from ./settings/groups.tsx and
 * the URL picks which one shows.
 */
export function SettingsPage({ group }: { group?: string }) {
  const res = useLiveResource('settings', api.settings, () => false);
  const s = res.data;
  const [query, setQuery] = useState('');

  const groups = settingsGroups(s);
  const active = resolveSettingsGroup(groups, group, !!s);
  // The nav filters, the page does not: a search must never hide the group you are reading.
  const nav = settingsNav(matchSettingsGroups(groups, query));

  return (
    <>
      <div className="lx-bar">
        <div className="lx-crumb">
          <a href={href.settings}>Settings</a>
          {active && (
            <>
              <span>›</span>
              <b>{active.label}</b>
            </>
          )}
        </div>
      </div>
      <div className="ox-set">
        <nav className="ox-snav ox-snav-set" aria-label="Settings">
          <div className="ox-snq">
            <input className="lx-input" type="search" aria-label="Search settings" placeholder="Search settings" value={query} onChange={(e) => setQuery(e.target.value)} spellCheck={false} />
          </div>
          {nav.map((c) => (
            <Fragment key={c.id}>
              <div className="ox-sncat">{c.label}</div>
              {c.groups.map((g) => (
                <a key={g.id} className="ox-snb ox-snitem" href={href.settingsGroup(g.id)} aria-current={g.id === active?.id ? 'page' : undefined} title={g.blurb}>
                  <span className="ox-trunc">{g.label}</span>
                </a>
              ))}
            </Fragment>
          ))}
          {nav.length === 0 && (
            <div className="lx-hint" style={{ padding: '6px 10px' }}>
              Nothing matches “{query}”.
            </div>
          )}
        </nav>
        <div className="ox-smain">
          <div className="ox-sdoc">
            {res.error && <div className="lx-error">{res.error}</div>}
            {res.loading && !s && !res.error && (
              <div className="lx-loading">
                <span className="lx-spin" /> Loading…
              </div>
            )}
            {s && active && (
              <>
                <div className="ox-sghead">
                  <h1 className="ox-h1">{active.label}</h1>
                  <div className="ox-sub">{active.blurb}</div>
                </div>
                <div className="ox-sgroup">{active.render({ settings: s, reload: res.reload })}</div>
              </>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
