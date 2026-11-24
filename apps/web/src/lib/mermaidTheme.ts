import type { MermaidConfig } from 'mermaid';

/**
 * Mermaid's config for one theme, in Orstra's palette.
 *
 * Mermaid needs real colours, so the palette has to be read out of the stylesheet rather than
 * copied here: `styles.css` stays the one home for a token. The browser passes a reader over the
 * document; a caller with no DOM passes its own.
 */

/** Reads one CSS variable, e.g. `--ink`. An empty string means the theme does not define it. */
export type Token = (name: string) => string;

/** Enough of a palette to draw on, for a page whose stylesheet has not loaded. */
const FALLBACK = {
  light: { '--surface': '#fff', '--surface-2': '#fbfbfd', '--accent-soft': '#e9f0fd', '--accent-line': '#cfddfb', '--ink': '#1d1d1f', '--ink-2': '#3a3a3f', '--fill': '#ececed', '--dim': '#a1a1a6' },
  dark: { '--surface': '#1f1f22', '--surface-2': '#232326', '--accent-soft': '#1c2a45', '--accent-line': '#2a3c63', '--ink': '#f5f5f7', '--ink-2': '#e0e0e5', '--fill': '#2a2a2e', '--dim': '#6e6e74' },
} as const;

const FONT = "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Inter', system-ui, sans-serif";

export function mermaidConfig(theme: 'light' | 'dark', token: Token): MermaidConfig {
  const fallback: Record<string, string> = { ...FALLBACK[theme], '--font': FONT };
  const read = (name: string) => token(name).trim() || fallback[name] || '';

  return {
    startOnLoad: false,
    // A diagram that will not parse makes mermaid throw instead of putting its own error graphic
    // on the page. The component then keeps the source and says what went wrong.
    suppressErrorRendering: true,
    // A message is untrusted: an agent reads the web, and a diagram carries its labels. Strict
    // sanitizes them, and with no HTML labels a label is text and never markup.
    securityLevel: 'strict',
    theme: 'base',
    flowchart: { htmlLabels: false, useMaxWidth: true },
    class: { htmlLabels: false, useMaxWidth: true },
    sequence: { useMaxWidth: true },
    themeVariables: {
      // Mermaid derives the colours it was not given. darkMode tells it which way.
      darkMode: theme === 'dark',
      background: read('--surface'),
      primaryColor: read('--accent-soft'),
      primaryBorderColor: read('--accent-line'),
      primaryTextColor: read('--ink'),
      secondaryColor: read('--fill'),
      tertiaryColor: read('--surface-2'),
      lineColor: read('--dim'),
      textColor: read('--ink-2'),
      fontFamily: read('--font'),
      fontSize: '13px',
    },
  };
}

/** The palette of the page itself. */
export function documentToken(): Token {
  const style = getComputedStyle(document.documentElement);
  return (name) => style.getPropertyValue(name);
}
