export interface Progress {
  did: string;
  decided?: string;
  left?: string;
  avoid?: string;
}

export interface AgentResult {
  outcome: 'done' | 'needs_you' | 'cant_do';
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

/** The agent's message without the trailing "## Progress" block and OUTCOME line (those are shown separately). */
export function stripProgressBlock(text: string): string {
  return text
    .replace(/\n?#{1,3}\s*Progress[\s\S]*$/i, '')
    .replace(/^\s*outcome\s*:.*$/gim, '')
    .trim();
}

/** Read the outcome line and the progress fields from an agent's final message. */
export function parseAgentResult(text: string): AgentResult {
  const outcomeMatch = text.match(/^\s*outcome\s*:\s*(done|needs_you|cant_do)\b/im);
  const outcome = (outcomeMatch?.[1]?.toLowerCase() ?? 'done') as AgentResult['outcome'];

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
