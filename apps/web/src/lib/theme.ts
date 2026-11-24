import { useSyncExternalStore } from 'react';

export type ThemeChoice = 'system' | 'light' | 'dark';

const KEY = 'orstra:theme';
const listeners = new Set<() => void>();
const media = typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: dark)') : null;

export function getThemeChoice(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

export const resolveTheme = (choice: ThemeChoice): 'light' | 'dark' => (choice === 'system' ? (media?.matches ? 'dark' : 'light') : choice);

function apply() {
  document.documentElement.dataset.theme = resolveTheme(getThemeChoice());
  listeners.forEach((l) => l());
}

export function setThemeChoice(choice: ThemeChoice) {
  try {
    if (choice === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch {
    /* storage unavailable: the choice lasts for this page load only */
  }
  apply();
}

/** Keep the page in step with the OS setting (when on "System") and with other tabs. */
export function initTheme() {
  apply();
  media?.addEventListener('change', apply);
  window.addEventListener('storage', (e) => e.key === KEY && apply());
}

/** Call `cb` whenever the theme changes. Returns the undo. */
export const subscribeTheme = (cb: () => void) => {
  listeners.add(cb);
  return () => void listeners.delete(cb);
};

/** The saved choice and the theme it resolves to right now. */
export function useTheme() {
  const choice = useSyncExternalStore(subscribeTheme, getThemeChoice);
  const resolved = useSyncExternalStore(subscribeTheme, () => resolveTheme(getThemeChoice()));
  return { choice, resolved };
}
