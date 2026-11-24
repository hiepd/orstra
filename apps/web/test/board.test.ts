import { describe, expect, it } from 'vitest';
import { boardColumns } from '../src/lib/board';

const steps = [
  { id: 'work', title: 'In progress' },
  { id: 'review', title: 'In review' },
  { id: 'merge', title: 'Merge' },
];
const t = (id: string, status: string, currentStep: string | null, currentStepTitle: string | null = null) => ({ id, status, currentStep, currentStepTitle }) as never;

describe('boardColumns', () => {
  it('has a column per step and 1 Done column for the tasks that ended', () => {
    const cols = boardColumns(steps, [t('a', 'running', 'work'), t('b', 'needs_you', 'review'), t('c', 'done', null), t('d', 'stopped', 'work')]);
    expect(cols.map((c) => [c.name, c.cards.length])).toEqual([
      ['In progress', 1],
      ['In review', 1],
      ['Merge', 0],
      ['Done', 2],
    ]);
  });

  it('never shows a second Done column for an empty step titled Done', () => {
    const cols = boardColumns([...steps, { id: 'done', title: 'Done' }], [t('c', 'done', null)]);
    expect(cols.filter((c) => c.name === 'Done')).toHaveLength(1);
  });

  it('keeps a task whose step the workflow file no longer has, in a column of its own', () => {
    const cols = boardColumns(steps, [t('old', 'needs_you', 'done', 'Done'), t('c', 'done', null)]);
    expect(cols.map((c) => c.name)).toEqual(['In progress', 'In review', 'Merge', 'Done · older version', 'Done']);
    expect(cols[3].cards.map((c: { id: string }) => c.id)).toEqual(['old']);
  });
});
