import type { TaskSummary } from '../api';

export type BoardColumn<T> = { id: string; name: string; cards: T[] };
type Card = Pick<TaskSummary, 'status' | 'currentStep' | 'currentStepTitle'>;

const finished = (t: Card) => t.status === 'done' || t.status === 'stopped';

/**
 * The Board's columns for one workflow: a column per step, then 1 Done column for the tasks that ended.
 * Done is where a finished task is, never a step, so a step titled "Done" shows only while a task waits
 * there. A task can sit at a step the workflow file no longer has (it keeps the version it started
 * with): it gets a column of its own, named as that version named it, so it never drops off the Board.
 */
export function boardColumns<T extends Card>(steps: { id: string; title: string }[], tasks: T[]): BoardColumn<T>[] {
  const active = tasks.filter((t) => !finished(t));
  const at = (id: string) => active.filter((t) => t.currentStep === id);
  const known = new Set(steps.map((s) => s.id));
  const cols: BoardColumn<T>[] = steps
    .filter((s) => s.title.trim().toLowerCase() !== 'done' || at(s.id).length > 0)
    .map((s) => ({ id: s.id, name: s.title, cards: at(s.id) }));
  const orphans = [...new Set(active.filter((t) => t.currentStep && !known.has(t.currentStep)).map((t) => t.currentStep as string))];
  for (const id of orphans) {
    const cards = at(id);
    cols.push({ id: `old:${id}`, name: `${cards[0].currentStepTitle ?? id} · older version`, cards });
  }
  cols.push({ id: '__done', name: 'Done', cards: tasks.filter(finished) });
  return cols;
}
