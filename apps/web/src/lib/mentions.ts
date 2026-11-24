type Named = { id: string; ref: string | null; title: string };

/** A title this short reads like plain words ("Fix it"), so it never counts as a mention. */
const MIN_TITLE = 12;

/** The tasks a message names: by ticket, by short id (the first 8 characters), or by full title. */
export function mentionedTasks<T extends Named>(text: string, tasks: T[]): T[] {
  const lower = text.toLowerCase();
  return tasks.filter((t) => (t.ref && text.includes(t.ref)) || text.includes(t.id.slice(0, 8)) || (t.title.length >= MIN_TITLE && lower.includes(t.title.toLowerCase())));
}

/** How long a card's line may be before what follows its first colon folds. */
const CARD_MAX = 120;

/**
 * A card in 1 line. Older cards put the whole instruction in the line ("Watching X: when it is …"):
 * the part after the first colon folds. A card the daemon wrote with a detail is already short.
 */
export function splitCard(text: string): { text: string; detail: string } {
  const at = text.indexOf(': ');
  if (text.length <= CARD_MAX || at < 0) return { text, detail: '' };
  return { text: text.slice(0, at), detail: text.slice(at + 2) };
}
