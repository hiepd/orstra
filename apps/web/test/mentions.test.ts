import { describe, expect, it } from 'vitest';
import { mentionedTasks, splitCard } from '../src/lib/mentions';

const tasks = [
  { id: 't-mwu3miu0ybfc', ref: null, title: 'Turn on the Claude Artifact tool for Orstra agents' },
  { id: 't-mwt4a4b0rgho', ref: 'HUB-416', title: 'Redesign the settings page' },
  { id: 't-mwt5ry6u6x7u', ref: null, title: 'Fix it' },
];

describe('mentionedTasks', () => {
  it('finds a task by its title, its ticket or its short id', () => {
    expect(mentionedTasks('“Turn on the Claude Artifact tool for Orstra agents” is done.', tasks).map((t) => t.id)).toEqual(['t-mwu3miu0ybfc']);
    expect(mentionedTasks('HUB-416 waits for you.', tasks).map((t) => t.id)).toEqual(['t-mwt4a4b0rgho']);
    expect(mentionedTasks('t-mwu3mi is done and sits at the review.', tasks).map((t) => t.id)).toEqual(['t-mwu3miu0ybfc']);
  });

  it('ignores a title too short to tell from plain words', () => {
    expect(mentionedTasks('Fix it now, please.', tasks)).toEqual([]);
  });
});

describe('splitCard', () => {
  it('keeps a short card whole', () => {
    expect(splitCard('Started “Ship it” · Simple')).toEqual({ text: 'Started “Ship it” · Simple', detail: '' });
  });

  it('folds the instruction of an older, long card', () => {
    const long = 'Watching t-mwu3mi: when it’s waiting for you, check why t-mwu3mi needs the user. Read the task. Tell the user which files it changed and the URL.';
    expect(splitCard(long)).toEqual({ text: 'Watching t-mwu3mi', detail: 'when it’s waiting for you, check why t-mwu3mi needs the user. Read the task. Tell the user which files it changed and the URL.' });
  });
});
