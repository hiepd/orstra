/**
 * Long agent messages, cut for a card. Markdown is split into blocks at blank lines, and a fenced code
 * block stays 1 block even when it has blank lines inside.
 */

const FENCE = /^\s*(```|~~~)/;
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;

/** The message's blocks, in order. A fence keeps its blank lines. */
function blocks(text: string): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  let inFence = false;
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    if (FENCE.test(line)) inFence = !inFence;
    if (!inFence && !line.trim()) {
      if (cur.length) out.push(cur.join('\n'));
      cur = [];
      continue;
    }
    cur.push(line);
  }
  if (cur.length) out.push(cur.join('\n'));
  return out;
}

/**
 * What a card shows of a message: its first paragraph and the names of its parts (its headings). Code
 * never shows: a diagram or a file in a card is noise; the whole message is in Chat.
 */
export function briefOf(text: string): { lead: string; parts: string[]; cut: boolean } {
  const all = blocks(text.trim());
  const lead = all.find((b) => !FENCE.test(b) && !HEADING.test(b.split('\n')[0])) ?? '';
  const parts = all.map((b) => b.split('\n')[0].match(HEADING)?.[1]).filter((h): h is string => !!h);
  return { lead, parts, cut: all.length > 1 };
}

/** How much a reply may say before the rest folds: the first 2 blocks, and only when 300 or more characters follow. */
const LEAD_BLOCKS = 2;
const FOLD_AT = 300;

/** A reply split into what you read first and what folds under it. A short reply folds nothing. */
export function splitReply(text: string): { lead: string; rest: string } {
  const all = blocks(text.trim());
  const rest = all.slice(LEAD_BLOCKS).join('\n\n');
  if (rest.length < FOLD_AT) return { lead: all.join('\n\n'), rest: '' };
  return { lead: all.slice(0, LEAD_BLOCKS).join('\n\n'), rest };
}
