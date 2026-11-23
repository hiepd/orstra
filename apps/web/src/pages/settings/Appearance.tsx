import { SettingsCard, SettingsRow } from '../../components/SettingsRow';
import { setThemeChoice, useTheme, type ThemeChoice } from '../../lib/theme';

const THEMES: { id: ThemeChoice; label: string }[] = [
  { id: 'system', label: 'System' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
];

/** How Orstra looks. Kept in this browser, so the daemon knows nothing about it. */
export function AppearanceGroup() {
  const { choice } = useTheme();
  return (
    <SettingsCard>
      <SettingsRow label="Theme" help="System follows your OS. Saved in this browser.">
        <div className="ox-seg" role="radiogroup" aria-label="Theme">
          {THEMES.map((t) => (
            <button key={t.id} type="button" role="radio" aria-checked={choice === t.id} className={choice === t.id ? 'ox-on' : undefined} onClick={() => setThemeChoice(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
      </SettingsRow>
    </SettingsCard>
  );
}
