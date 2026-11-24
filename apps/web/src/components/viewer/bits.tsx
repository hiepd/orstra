import type { ReactNode } from 'react';

/** A stroked 24 × 24 icon. */
export const Svg = ({ d, size = 15, sw = 1.9, color }: { d: string; size?: number; sw?: number; color?: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={color ? { color } : undefined}>
    <path d={d} />
  </svg>
);

/** A panel's toolbar: optional buttons, where the panel looks (a path or a URL), then its controls. */
export function Tool({ where, before, children }: { where: string; before?: ReactNode; children?: ReactNode }) {
  return (
    <div className="vw-tool">
      {before}
      <span className="vw-where" title={where}>
        <span>{where}</span>
      </span>
      {children}
    </div>
  );
}

/** A segmented control of 2 or more choices. */
export function Seg<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { id: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="vw-seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.id} type="button" aria-pressed={value === o.id} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
