import type { Progress } from '../api';

const FIELDS: [keyof Progress, string][] = [
  ['did', 'Did'],
  ['decided', 'Decided'],
  ['left', 'Left'],
  ['avoid', 'Avoid'],
];

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
          <dd>{progress[k]}</dd>
        </div>
      ))}
    </dl>
  );
}
