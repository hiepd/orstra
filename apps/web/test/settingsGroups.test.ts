import { describe, expect, it } from 'vitest';
import { matchSettingsGroups, resolveSettingsGroup, settingsNav, type SettingsGroupMeta } from '../src/lib/settingsGroups';

const group = (id: string, label: string, category: SettingsGroupMeta['category'], blurb = '', keywords: string[] = []): SettingsGroupMeta => ({ id, label, category, blurb, keywords });

// The real shape: static groups in registry order, then the groups the daemon's agents add.
const groups: SettingsGroupMeta[] = [
  group('appearance', 'Appearance', 'general', 'How Orstra looks in this browser.', ['theme', 'dark']),
  group('runner', 'Runner', 'machine', 'How much the daemon runs at once.', ['slots', 'port']),
  group('files', 'Files', 'machine', 'Where Orstra keeps workflows and worktrees.', ['sqlite']),
  group('agent-claude-code', 'Claude Code', 'agents', 'Defaults its steps use.', ['effort', 'permission mode']),
  group('agent-codex', 'Codex', 'agents', 'Defaults its steps use.', ['model']),
];

describe('resolveSettingsGroup', () => {
  it('picks the group the URL names', () => {
    expect(resolveSettingsGroup(groups, 'files', true)?.id).toBe('files');
    expect(resolveSettingsGroup(groups, 'agent-codex', true)?.id).toBe('agent-codex');
  });

  it('falls back to the first group for no id and for an id we don’t know', () => {
    expect(resolveSettingsGroup(groups, undefined, true)?.id).toBe('appearance');
    expect(resolveSettingsGroup(groups, 'gone', true)?.id).toBe('appearance');
  });

  it('waits instead of falling back while the daemon-made groups are missing', () => {
    // #/settings/agent-codex loaded cold: the agent groups aren't there yet. Falling back
    // now would show Appearance and lose the link the person opened.
    const early = groups.filter((g) => g.category !== 'agents');
    expect(resolveSettingsGroup(early, 'agent-codex', false)).toBeUndefined();
    expect(resolveSettingsGroup(groups, 'agent-codex', true)?.id).toBe('agent-codex');
  });
});

describe('matchSettingsGroups', () => {
  it('returns everything for an empty or blank query', () => {
    expect(matchSettingsGroups(groups, '')).toHaveLength(groups.length);
    expect(matchSettingsGroups(groups, '   ')).toHaveLength(groups.length);
  });

  it('finds a group by a word only its keywords hold', () => {
    expect(matchSettingsGroups(groups, 'sqlite').map((g) => g.id)).toEqual(['files']);
    expect(matchSettingsGroups(groups, 'effort').map((g) => g.id)).toEqual(['agent-claude-code']);
  });

  it('matches the label and the blurb, and ignores case', () => {
    expect(matchSettingsGroups(groups, 'CODEX').map((g) => g.id)).toEqual(['agent-codex']);
    expect(matchSettingsGroups(groups, 'worktrees').map((g) => g.id)).toEqual(['files']);
  });

  it('needs every word, so more words narrow the list', () => {
    expect(matchSettingsGroups(groups, 'permission mode').map((g) => g.id)).toEqual(['agent-claude-code']);
    expect(matchSettingsGroups(groups, 'defaults steps').map((g) => g.id)).toEqual(['agent-claude-code', 'agent-codex']);
    expect(matchSettingsGroups(groups, 'sqlite theme')).toEqual([]);
  });
});

describe('settingsNav', () => {
  it('orders categories and keeps registry order inside each one', () => {
    expect(settingsNav(groups).map((c) => [c.label, c.groups.map((g) => g.id)])).toEqual([
      ['General', ['appearance']],
      ['Agents', ['agent-claude-code', 'agent-codex']],
      ['This machine', ['runner', 'files']],
    ]);
  });

  it('drops a category with nothing in it, so a search shows no empty headings', () => {
    expect(settingsNav(matchSettingsGroups(groups, 'sqlite')).map((c) => c.label)).toEqual(['This machine']);
  });
});
