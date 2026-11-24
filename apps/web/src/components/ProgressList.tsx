import type { ReactNode } from 'react';
import type { Progress } from '../api';

const FIELDS: [keyof Progress, string][] = [
  ['did', 'Did'],
  ['decided', 'Decided'],
  ['left', 'Left'],
  ['avoid', 'Avoid'],
];

/** Inline code in a progress line, as the agent wrote it in backticks. Everything else stays text. */
export function withCode(text: string): ReactNode[] {
  return text.split(/(`[^`\n]+`)/).map((part, i) => (part.length > 2 && part.startsWith('`') && part.endsWith('`') ? <code key={i}>{part.slice(1, -1)}</code> : part));
}

const isNothing = (v: string) => /^\s*(nothing|none|n\/a)\.?\s*$/i.test(v);

/** A run's progress entry: Did / Decided / Left / Avoid. Empty or "nothing" fields are dropped. */
export function ProgressList({ progress }: { progress: Progress }) {
  const rows = FIELDS.filter(([k]) => {
    const v = progress[k];
    return typeof v === 'string' && v.trim() && !(k !== 'did' && isNothing(v));
  });
  if (rows.length === 0) return <p className="lx-hint" style={{ margin: 0 }}>No progress written.</p>;
  return (
    <dl className="lx-dl">
      {rows.map(([k, label]) => (
        <div key={k} style={{ display: 'contents' }}>
          <dt>{label}</dt>
          <dd>{withCode(progress[k] as string)}</dd>
        </div>
      ))}
    </dl>
  );
}
