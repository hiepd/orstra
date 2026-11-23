import type { ReactNode } from 'react';

/** A setting: its name and help on the left, its control on the right. */
export function SettingsRow({ label, help, children }: { label: string; help: ReactNode; children: ReactNode }) {
  return (
    <div className="ox-srow2">
      <div className="ox-sl">
        <div className="ox-lb">{label}</div>
        <div className="ox-hp">{help}</div>
      </div>
      {children}
    </div>
  );
}

/** A setting the daemon owns: it shows a value instead of a control. `ok` colours the value. */
export function SettingsValue({ label, help, value, mono, ok }: { label: string; help: ReactNode; value: string; mono?: boolean; ok?: boolean }) {
  return (
    <SettingsRow label={label} help={help}>
      <span className={mono ? 'ox-val lx-mono' : 'ox-val'} style={ok === undefined ? undefined : { color: ok ? 'var(--green-fg)' : 'var(--red-fg)' }} title={value}>
        {value}
      </span>
    </SettingsRow>
  );
}

/**
 * One card of rows inside a group, with an optional heading above it and an optional note
 * under it. Groups stack these; the gaps come from .ox-sgroup, so no group sets its own
 * spacing.
 */
export function SettingsCard({ title, note, children }: { title?: string; note?: ReactNode; children: ReactNode }) {
  return (
    <section className="ox-sblock">
      {title && <h2 className="ox-h2">{title}</h2>}
      <div className="ox-card">{children}</div>
      {note && <div className="lx-hint">{note}</div>}
    </section>
  );
}
