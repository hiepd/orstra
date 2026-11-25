import type { ReactNode } from 'react';
import type { Settings } from '../../api';
import type { SettingsGroupMeta } from '../../lib/settingsGroups';
import { AgentGroup } from './Agent';
import { AppearanceGroup } from './Appearance';
import { FilesGroup } from './Files';
import { RunnerGroup } from './Runner';
import { UsageGroup } from './Usage';

/**
 * The registry: every group Settings can show. This is the only file that changes when a
 * group is added, and the only file that knows the whole list.
 *
 * To add a group:
 *   1. Write ./<Name>.tsx. Export one component. It renders <SettingsCard> rows and nothing
 *      else: no page frame, no heading, no spacing.
 *   2. Add one entry to STATIC_GROUPS below. Its `category` puts it in the nav; its
 *      `keywords` make it findable by words the label and blurb don't hold.
 * The nav, the search, the heading, the URL #/settings/<id> and the deep link all follow.
 */

export interface SettingsGroupContext {
  settings: Settings;
  /** Refetches the settings, so a group can show what it just saved. */
  reload: () => void;
}

export interface SettingsGroup extends SettingsGroupMeta {
  render: (ctx: SettingsGroupContext) => ReactNode;
}

/** Groups that are always there. */
const STATIC_GROUPS: SettingsGroup[] = [
  {
    id: 'appearance',
    label: 'Appearance',
    category: 'general',
    blurb: 'How Orstra looks in this browser.',
    keywords: ['theme', 'dark', 'light', 'system', 'colour', 'color'],
    render: () => <AppearanceGroup />,
  },
  {
    id: 'usage',
    label: 'Usage',
    category: 'general',
    blurb: 'What agent runs cost today and this week.',
    keywords: ['cost', 'money', 'tokens', 'budget', 'spend', 'dollars'],
    render: ({ settings }) => <UsageGroup s={settings} />,
  },
  {
    id: 'runner',
    label: 'Runner',
    category: 'machine',
    blurb: 'How much the daemon runs at once, and where it serves this page.',
    keywords: ['slots', 'port', 'parallel', 'at the same time', 'daemon', 'ORSTRA_SLOTS', 'ORSTRA_PORT'],
    render: ({ settings }) => <RunnerGroup s={settings} />,
  },
  {
    id: 'files',
    label: 'Files',
    category: 'machine',
    blurb: 'Where Orstra keeps workflows, worktrees and its database.',
    keywords: ['folder', 'path', 'home', 'database', 'sqlite', 'worktree', 'branch', 'workflows', 'ORSTRA_HOME'],
    render: ({ settings }) => <FilesGroup s={settings} />,
  },
];

/**
 * One group per agent the daemon reports. These are data, not code: a new agent shows up
 * here on its own, which is why the group list is a function of the settings.
 */
function agentGroups(settings: Settings | undefined): SettingsGroup[] {
  return (settings?.agents ?? []).map((agent) => ({
    id: `agent-${agent.id}`,
    label: agent.name,
    category: 'agents' as const,
    blurb: `Whether this machine can run ${agent.name}, and the defaults its steps use.`,
    // Only the fields this agent really shows, so a search never offers a group that
    // doesn't hold what was searched for. Effort and permission mode are Claude's alone.
    keywords: ['agent', 'model', agent.id, agent.command, ...(agent.id === 'claude-code' ? ['effort', 'permission mode', 'ask for permission'] : [])],
    render: ({ settings: s, reload }) => <AgentGroup s={s} agent={agent} onSaved={reload} />,
  }));
}

/** Every group. Order here only matters inside a category; the nav sorts by category. */
export function settingsGroups(settings: Settings | undefined): SettingsGroup[] {
  return [...STATIC_GROUPS, ...agentGroups(settings)];
}
