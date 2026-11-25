export interface Progress {
  did: string;
  decided?: string;
  left?: string;
  avoid?: string;
}

export interface AgentResult {
  /** done, needs_you, cant_do, or an outcome the step declares in `on:` (see agentOutcomes). */
  outcome: string;
  /** false when the agent didn't write an OUTCOME line (outcome then defaults to done). */
  hasOutcome: boolean;
  progress: Progress;
}

/** Appended to every agent prompt so the run ends in a form Orstra can read. */
export const FINISH_INSTRUCTIONS = `
When you are finished, end your final message with exactly this:

## Progress
Did: <one or two sentences on what you did>
Decided: <decisions you made without asking, or "nothing">
Left: <what is left for the next step, or "nothing">
Avoid: <dead ends the next session should not repeat, or "nothing">

OUTCOME: done | needs_you | cant_do

Use needs_you when you need a human decision, and cant_do when the task cannot be done as asked.`;

const FIELD = /^(did|decided|left|avoid)\s*:\s*(.*)$/i;

/** Outcomes Orstra sets itself, or an agent always has: never listed as a step's own. */
const RESERVED = new Set(['done', 'needs_you', 'cant_do', 'timeout', 'over_budget', 'skipped', 'crashed', 'interrupted', 'setup_failed']);

/**
 * The outcomes an agent step adds to done, needs_you and cant_do: each arrow in its `on:` that is not
 * a reserved outcome. With `on: { small: ship, large: plan }` the agent itself picks the branch.
 */
export function agentOutcomes(on: Record<string, unknown>): string[] {
  return Object.keys(on).filter((k) => !RESERVED.has(k) && /^[\w-]+$/.test(k));
}

/** FINISH_INSTRUCTIONS, with the step's own outcomes on the OUTCOME line. */
export function finishInstructions(extra: string[] = []): string {
  if (!extra.length) return FINISH_INSTRUCTIONS;
  return FINISH_INSTRUCTIONS.replace('OUTCOME: done | needs_you | cant_do', `OUTCOME: ${['done', ...extra].join(' | ')} | needs_you | cant_do`).replace(
    'Use needs_you when',
    `Pick ${extra.join(', ')} or done for how the step ended: each one leads to a different next step. Use needs_you when`,
  );
}

/** The agent's message without the trailing "## Progress" block and OUTCOME line (those are shown separately). */
export function stripProgressBlock(text: string): string {
  return text
    .replace(/\n?#{1,3}\s*Progress[\s\S]*$/i, '')
    .replace(/^\s*outcome\s*:.*$/gim, '')
    .trim();
}

/** Read the outcome line and the progress fields from an agent's final message. */
export function parseAgentResult(text: string, extra: string[] = []): AgentResult {
  const names = ['done', 'needs_you', 'cant_do', ...extra.filter((e) => /^[\w-]+$/.test(e))];
  const esc = (n: string) => n.replace(/[-]/g, '\\-');
  const outcomeMatch = text.match(new RegExp(`^\\s*outcome\\s*:\\s*(${names.map(esc).join('|')})(?![\\w-])`, 'im'));
  const said = outcomeMatch?.[1]?.toLowerCase();
  const outcome = names.find((n) => n.toLowerCase() === said) ?? 'done';

  const progress: Progress = { did: '' };
  for (const line of text.split('\n')) {
    const m = line.trim().match(FIELD);
    if (m) (progress as unknown as Record<string, string>)[m[1].toLowerCase()] = m[2].trim();
  }
  if (!progress.did) {
    const body = text.replace(/^\s*outcome\s*:.*$/gim, '').trim();
    progress.did = body.length > 400 ? body.slice(0, 397) + '…' : body;
  }
  return { outcome, hasOutcome: !!outcomeMatch, progress };
}
