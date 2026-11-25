import { describe, expect, it } from 'vitest';
import { checkCron, dateIn, describeCron, fillDate, nextCron, parseWorkflow } from '../src/index.ts';

const HUMAN = `steps:\n  review:\n    use: human\n    question: ok?\n    on: { approved: end }\n`;
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
const t = (s: string) => Date.parse(s);

describe('cron with a timezone', () => {
  it('reads the hours in the timezone, across a change of the clocks', () => {
    // London is UTC+0 in winter and UTC+1 in summer. Clocks went forward on 29 March 2026.
    expect(iso(nextCron('0 9 * * 1-5', 'Europe/London', t('2026-03-26T12:00:00Z')))).toBe('2026-03-27T09:00:00.000Z');
    expect(iso(nextCron('0 9 * * 1-5', 'Europe/London', t('2026-03-27T12:00:00Z')))).toBe('2026-03-30T08:00:00.000Z');
  });

  it('uses UTC when there is no timezone', () => {
    expect(iso(nextCron('30 6 * * *', null, t('2026-11-25T07:00:00Z')))).toBe('2026-11-26T06:30:00.000Z');
  });

  it('skips the weekend for a weekday cron, in a timezone east of UTC', () => {
    // Friday 23:30 UTC is already Saturday in Tokyo, so the next weekday 09:00 there is Monday.
    expect(iso(nextCron('0 9 * * 1-5', 'Asia/Tokyo', t('2026-11-27T23:30:00Z')))).toBe('2026-11-30T00:00:00.000Z');
  });

  it('gives the next time strictly after the one it is given', () => {
    expect(iso(nextCron('0 9 * * *', 'UTC', t('2026-11-25T09:00:00Z')))).toBe('2026-11-26T09:00:00.000Z');
  });

  it('refuses a wrong cron and a wrong timezone, readably', () => {
    expect(() => checkCron('0 9 * *')).toThrow(/5 fields/);
    expect(() => checkCron('0 0 9 * * 1')).toThrow(/5 fields/);
    expect(() => checkCron('99 9 * * *')).toThrow(/not a cron expression/);
    expect(() => checkCron('0 9 * * 1-5', 'Mars/Olympus')).toThrow(/not a timezone/);
    expect(checkCron('  0   9 * * 1-5 ')).toBe('0 9 * * 1-5');
  });

  it('says the cron in words', () => {
    expect(describeCron('0 9 * * 1-5')).toBe('At 09:00, Monday through Friday');
    expect(describeCron('*/15 * * * *')).toBe('Every 15 minutes');
  });

  it('fills {{ date }} with the date in the timezone', () => {
    const ms = t('2026-11-25T23:30:00Z');
    expect(dateIn(ms)).toBe('2026-11-25');
    expect(dateIn(ms, 'Asia/Tokyo')).toBe('2026-11-26');
    expect(fillDate('Triage {{ date }}', ms, 'America/New_York')).toBe('Triage 2026-11-25');
  });
});

describe('the schedule trigger in YAML', () => {
  it('reads a cron and a timezone', () => {
    const wf = parseWorkflow(`name: X\ntriggers:\n  - schedule: { cron: "0 9 * * 1-5", timezone: Europe/London, title: Triage, workspace: hub }\n${HUMAN}`);
    expect(wf.triggers[0]).toEqual({ kind: 'schedule', cron: '0 9 * * 1-5', timezone: 'Europe/London', title: 'Triage', workspace: 'hub' });
  });

  it('keeps every: working', () => {
    const wf = parseWorkflow(`name: X\ntriggers:\n  - schedule: { every: 1d, title: "Dogfood Orstra" }\n${HUMAN}`);
    expect(wf.triggers[0]).toEqual({ kind: 'schedule', everyMinutes: 1440, title: 'Dogfood Orstra' });
  });

  it('wants exactly 1 of cron and every, and a timezone only with cron', () => {
    expect(() => parseWorkflow(`name: X\ntriggers:\n  - schedule: { title: T }\n${HUMAN}`)).toThrow(/either cron/);
    expect(() => parseWorkflow(`name: X\ntriggers:\n  - schedule: { cron: "0 9 * * *", every: 1d, title: T }\n${HUMAN}`)).toThrow(/either cron/);
    expect(() => parseWorkflow(`name: X\ntriggers:\n  - schedule: { every: 1d, timezone: UTC, title: T }\n${HUMAN}`)).toThrow(/only with cron/);
    expect(() => parseWorkflow(`name: X\ntriggers:\n  - schedule: { cron: "0 9 * * *", timezone: Nowhere, title: T }\n${HUMAN}`)).toThrow(/not a timezone/);
  });
});
