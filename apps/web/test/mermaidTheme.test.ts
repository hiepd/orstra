import { describe, expect, it } from 'vitest';
import { mermaidConfig } from '../src/lib/mermaidTheme';

/** A palette whose every variable answers with its own name, so a test can see which one was read. */
const named = (name: string) => `<${name}>`;

/** The palette of a theme that defines nothing. */
const none = () => '';

describe('mermaidConfig', () => {
  it('draws by hand, not on load', () => {
    expect(mermaidConfig('light', named).startOnLoad).toBe(false);
  });

  it('leaves a failure to the component instead of drawing its own', () => {
    expect(mermaidConfig('light', named).suppressErrorRendering).toBe(true);
  });

  it('keeps a label as text, since a message is untrusted', () => {
    const cfg = mermaidConfig('light', named);
    expect(cfg.securityLevel).toBe('strict');
    expect(cfg.flowchart?.htmlLabels).toBe(false);
    expect(cfg.class?.htmlLabels).toBe(false);
  });

  it('takes the palette from the stylesheet, not from its own copy', () => {
    const cfg = mermaidConfig('light', named);
    expect(cfg.themeVariables).toMatchObject({
      background: '<--surface>',
      primaryColor: '<--accent-soft>',
      primaryBorderColor: '<--accent-line>',
      primaryTextColor: '<--ink>',
      secondaryColor: '<--fill>',
      tertiaryColor: '<--surface-2>',
      lineColor: '<--dim>',
      textColor: '<--ink-2>',
      fontFamily: '<--font>',
    });
  });

  it('builds its shades on the right side of the ground', () => {
    expect(mermaidConfig('light', named).themeVariables?.darkMode).toBe(false);
    expect(mermaidConfig('dark', named).themeVariables?.darkMode).toBe(true);
  });

  it('derives every other colour from those, so it stays one palette', () => {
    expect(mermaidConfig('light', named).theme).toBe('base');
  });

  it('falls back to a readable colour when a variable is missing', () => {
    const cfg = mermaidConfig('dark', none);
    const vars = cfg.themeVariables ?? {};
    for (const [key, value] of Object.entries(vars)) {
      if (typeof value === 'string') expect(value, key).not.toBe('');
    }
    expect(vars.background).not.toBe(vars.textColor);
  });

  it('gives a light theme light fallbacks and a dark theme dark ones', () => {
    const light = mermaidConfig('light', none).themeVariables ?? {};
    const dark = mermaidConfig('dark', none).themeVariables ?? {};
    expect(light.background).not.toBe(dark.background);
    expect(light.textColor).not.toBe(dark.textColor);
  });

  it('trims the value a stylesheet hands back with its leading space', () => {
    const padded = (name: string) => (name === '--ink' ? ' #1d1d1f ' : '#000');
    expect(mermaidConfig('light', padded).themeVariables?.primaryTextColor).toBe('#1d1d1f');
  });
});
