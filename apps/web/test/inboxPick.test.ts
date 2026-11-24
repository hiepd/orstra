import { describe, expect, it } from 'vitest';
import { pickInboxTask } from '../src/lib/inboxPick';

const list = [
  { id: 'a', state: 'decision' as const },
  { id: 'b', state: 'question' as const },
];

describe('pickInboxTask', () => {
  it('opens the task in the URL, with its view', () => {
    expect(pickInboxTask({ sel: 'b', selView: 'chat', kept: null, list })).toEqual({ id: 'b', view: 'chat' });
  });

  it('keeps the task in the URL open after it leaves the list (it runs now)', () => {
    expect(pickInboxTask({ sel: 'gone', selView: 'chat', kept: null, list })).toEqual({ id: 'gone', view: 'chat' });
  });

  it('opens the first task when nothing is picked, in Chat for a question', () => {
    expect(pickInboxTask({ kept: null, list })).toEqual({ id: 'a', view: 'overview' });
    expect(pickInboxTask({ kept: null, list: [list[1]] })).toEqual({ id: 'b', view: 'chat' });
  });

  it('keeps the task it opened, and its view, when that task leaves the list or a new one comes first', () => {
    const kept = { id: 'b', view: 'chat' as const };
    expect(pickInboxTask({ kept, list: [list[0]] })).toEqual(kept);
    expect(pickInboxTask({ kept, list: [{ id: 'new', state: 'decision' }, ...list] })).toEqual(kept);
  });

  it('opens nothing when nothing needs you and nothing was open', () => {
    expect(pickInboxTask({ kept: null, list: [] })).toBeNull();
  });
});
