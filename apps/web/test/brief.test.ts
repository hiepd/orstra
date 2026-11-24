import { describe, expect, it } from 'vitest';
import { briefOf, splitReply } from '../src/lib/brief';

const reply = [
  'Four scenarios, because one diagram covering them all would be unreadable.',
  '',
  '## A. Start and run',
  '',
  '```mermaid',
  'sequenceDiagram',
  '  A->>B: hi',
  '```',
  '',
  '## B. Clean restart',
  '',
  'Some text under B.',
].join('\n');

describe('briefOf', () => {
  it('keeps the first paragraph and the names of the parts, never the code', () => {
    expect(briefOf(reply)).toEqual({ lead: 'Four scenarios, because one diagram covering them all would be unreadable.', parts: ['A. Start and run', 'B. Clean restart'], cut: true });
  });

  it('leaves a short message whole', () => {
    expect(briefOf('Unit tests pass.')).toEqual({ lead: 'Unit tests pass.', parts: [], cut: false });
  });

  it('skips a heading or a fence at the top to find the first paragraph', () => {
    expect(briefOf('## Result\n\nIt works.\n\nMore here.').lead).toBe('It works.');
  });
});

describe('splitReply', () => {
  const long = ['The task is done and waits for your review.', 'It changed 7 files and 198 tests pass.', 'The core is in `executors.ts`: ' + 'x'.repeat(300), 'You can turn it off in 3 places.'].join('\n\n');

  it('shows the first 2 paragraphs and folds the rest of a long reply', () => {
    const s = splitReply(long);
    expect(s.lead).toBe('The task is done and waits for your review.\n\nIt changed 7 files and 198 tests pass.');
    expect(s.rest.startsWith('The core is in')).toBe(true);
  });

  it('folds nothing in a short reply', () => {
    expect(splitReply('Done.\n\nNothing else.')).toEqual({ lead: 'Done.\n\nNothing else.', rest: '' });
  });

  it('never cuts inside a fenced block', () => {
    const s = splitReply(['Lead.', 'Second.', '```\na\n\nb\n```', 'x'.repeat(400)].join('\n\n'));
    expect(s.rest.startsWith('```\na\n\nb\n```')).toBe(true);
  });
});
