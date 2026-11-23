/**
 * Settings is a list of groups. This module holds the shape of a group and the pure rules
 * the page needs: which group a URL asks for, which groups a search matches, and the order
 * they appear in the nav. The groups themselves are registered in src/pages/settings/groups.tsx.
 */

export type SettingsCategoryId = 'general' | 'agents' | 'machine';

/** Nav order. A group's category decides where it sits; order inside a category is the
 *  order the registry lists it in. */
export const SETTINGS_CATEGORIES: { id: SettingsCategoryId; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'agents', label: 'Agents' },
  { id: 'machine', label: 'This machine' },
];

export interface SettingsGroupMeta {
  /** Stable id. It is also the URL segment: #/settings/<id>. */
  id: string;
  /** The nav entry and the heading on the page. */
  label: string;
  category: SettingsCategoryId;
  /** One line under the heading. Search reads it. */
  blurb: string;
  /** Words someone might search for that the label and blurb don't hold. */
  keywords?: string[];
}

/**
 * The group the URL asks for. An id we don't know falls back to the first group, but only
 * once every group is there: some groups come from the daemon, so an early fallback would
 * send a good link to the wrong page.
 */
export function resolveSettingsGroup<T extends SettingsGroupMeta>(groups: T[], id: string | undefined, ready: boolean): T | undefined {
  return groups.find((g) => g.id === id) ?? (ready ? groups[0] : undefined);
}

/** Groups whose label, blurb or keywords hold every word of the query. */
export function matchSettingsGroups<T extends SettingsGroupMeta>(groups: T[], query: string): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return groups;
  return groups.filter((g) => {
    const hay = `${g.label} ${g.blurb} ${(g.keywords ?? []).join(' ')}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** The nav: categories in SETTINGS_CATEGORIES order, with empty ones dropped. */
export function settingsNav<T extends SettingsGroupMeta>(groups: T[]): { id: SettingsCategoryId; label: string; groups: T[] }[] {
  return SETTINGS_CATEGORIES.map((c) => ({ ...c, groups: groups.filter((g) => g.category === c.id) })).filter((c) => c.groups.length > 0);
}
