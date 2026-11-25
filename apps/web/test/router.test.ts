import { describe, expect, it } from 'vitest';
import { href, parseHash } from '../src/lib/router';

describe('parseHash: Triggers', () => {
  it('opens the Triggers page at its own address', () => {
    expect(parseHash(href.triggers)).toEqual({ name: 'triggers' });
    expect(parseHash('#/triggers')).toEqual({ name: 'triggers' });
  });

  it('sends the old Settings link to the Triggers page', () => {
    // Triggers was a Settings group. A link someone kept from then must still work.
    expect(parseHash('#/settings/triggers')).toEqual({ name: 'triggers' });
  });

  it('keeps the other Settings groups in Settings', () => {
    expect(parseHash('#/settings')).toEqual({ name: 'settings', group: undefined });
    expect(parseHash('#/settings/usage')).toEqual({ name: 'settings', group: 'usage' });
    expect(parseHash(href.settingsGroup('agent-codex'))).toEqual({ name: 'settings', group: 'agent-codex' });
  });

  it('has no deeper Triggers addresses', () => {
    expect(parseHash('#/triggers/x')).toEqual({ name: 'notFound', path: '/triggers/x' });
    expect(parseHash('#/settings/triggers/x')).toEqual({ name: 'notFound', path: '/settings/triggers/x' });
  });
});

describe('parseHash: the other pages', () => {
  it('still parses each sidebar page', () => {
    expect(parseHash('')).toEqual({ name: 'cos' });
    expect(parseHash(href.tasks)).toEqual({ name: 'tasks' });
    expect(parseHash(href.workflows)).toEqual({ name: 'workflows', file: undefined });
    expect(parseHash(href.workspaces)).toEqual({ name: 'workspaces', id: undefined, tab: 'overview' });
    expect(parseHash(href.inbox)).toEqual({ name: 'tasks', inbox: true, sel: undefined, selView: 'overview' });
  });
});
