import { describe, expect, it } from 'vitest';
import { AGENT_RETRY, parseDuration, parseWorkflow, retryDelay, retryPolicy, usageReset } from '../src/index.ts';

describe('parseDuration', () => {
  it('reads seconds, minutes, hours, days, and a bare number as minutes', () => {
    expect(parseDuration('30s')).toBe(30_000);
    expect(parseDuration('5m')).toBe(300_000);
    expect(parseDuration('2h')).toBe(7_200_000);
    expect(parseDuration('1d')).toBe(86_400_000);
    expect(parseDuration(3)).toBe(180_000);
  });

  it('refuses a text that is no duration', () => {
    expect(() => parseDuration('soon')).toThrow(/not a duration/);
  });
});

describe('retryDelay', () => {
  it('grows by the factor and stops at the cap', () => {
    expect([1, 2, 3, 4].map((n) => retryDelay(AGENT_RETRY, n))).toEqual([60_000, 240_000, 960_000, 1_800_000]);
  });
});

describe('usageReset', () => {
  it('reads the epoch form', () => {
    expect(usageReset('Claude AI usage limit reached|1764000000')).toBe(1_764_000_000_000);
  });

  it('reads "resets 3pm" as the next 3 pm on this clock', () => {
    const now = new Date(2026, 10, 25, 10, 0).getTime();
    expect(usageReset("You've hit your limit · resets 3pm", now)).toBe(new Date(2026, 10, 25, 15, 0).getTime());
    const late = new Date(2026, 10, 25, 16, 0).getTime();
    expect(usageReset('5-hour limit reached ∙ resets at 3:30 pm', late)).toBe(new Date(2026, 10, 26, 15, 30).getTime());
  });

  it('gives null for an error that names no time', () => {
    expect(usageReset('API Error: 529 overloaded')).toBeNull();
  });
});

describe('retry in a workflow', () => {
  const wf = (step: string) => parseWorkflow(`name: x\nsteps:\n  a:\n${step}`);

  it('gives an agent step 2 retries and a gate none, when they say nothing', () => {
    const w = parseWorkflow('name: x\nsteps:\n  a:\n    use: agent\n    prompt: hi\n    next: b\n  b:\n    use: gate\n    run: npm test\n');
    expect(retryPolicy(w.steps.a).max).toBe(2);
    expect(retryPolicy(w.steps.b).max).toBe(0);
  });

  it('reads the fields that differ from the default', () => {
    const p = retryPolicy(wf('    use: agent\n    prompt: hi\n    retry: { max: 5, delay: 30s, onTimeout: true }\n').steps.a);
    expect(p).toMatchObject({ max: 5, delayMs: 30_000, factor: 4, onTimeout: true });
  });

  it('reads retry: false as no retry', () => {
    expect(retryPolicy(wf('    use: agent\n    prompt: hi\n    retry: false\n').steps.a).max).toBe(0);
  });

  it('refuses retry on a human step, and a delay that is no duration', () => {
    expect(() => wf('    use: human\n    retry: { max: 1 }\n')).toThrow(/retry/);
    expect(() => wf('    use: agent\n    prompt: hi\n    retry: { delay: soon }\n')).toThrow(/not a duration/);
  });
});
