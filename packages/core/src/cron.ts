import { Cron } from 'croner';
import cronstrue from 'cronstrue';

/**
 * Cron for schedules, as trigger.dev has it: 5 fields (minute hour day-of-month month day-of-week)
 * and an optional IANA timezone. No timezone means UTC. Orstra checks once a minute, so there is no
 * seconds field.
 */

/** Throws a readable error when the timezone is not an IANA name such as "Europe/London". */
export function checkTimezone(tz: string): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    throw new Error(`"${tz}" is not a timezone. Use an IANA name such as Europe/London or America/New_York.`);
  }
  return tz;
}

function make(expr: string, tz?: string | null): Cron {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`"${expr}" is not a cron expression. Write 5 fields: minute hour day-of-month month day-of-week, such as "0 9 * * 1-5".`);
  }
  if (tz) checkTimezone(tz);
  try {
    // legacyMode: a day-of-month and a day-of-week both set means either one, as in classic cron.
    return new Cron(fields.join(' '), { timezone: tz || 'UTC', paused: true, legacyMode: true });
  } catch (err: any) {
    throw new Error(`"${expr}" is not a cron expression: ${err?.message ?? err}`);
  }
}

/** Throws when the expression or the timezone is wrong. Returns the expression, trimmed. */
export function checkCron(expr: string, tz?: string | null): string {
  make(expr, tz);
  return expr.trim().split(/\s+/).join(' ');
}

/** The first time after `after` (ms) that the cron matches, in ms. Null when it never matches again. */
export function nextCron(expr: string, tz: string | null | undefined, after: number): number | null {
  return make(expr, tz).nextRun(new Date(after))?.getTime() ?? null;
}

/** The cron in words: "At 09:00, Monday through Friday". Falls back to the expression. */
export function describeCron(expr: string): string {
  try {
    return cronstrue.toString(expr, { use24HourTimeFormat: true, throwExceptionOnParseError: true });
  } catch {
    return expr;
  }
}

/** The calendar date (YYYY-MM-DD) of `ms` in the timezone, for the `{{ date }}` placeholder. */
export function dateIn(ms: number, tz?: string | null): string {
  // en-CA writes dates as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}

/** The clock time (HH:mm, 24 hours) of `ms` in the timezone. */
export function timeIn(ms: number, tz?: string | null): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz || 'UTC', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
}

/** Fill `{{ date }}` in a schedule's title or description. */
export function fillDate(text: string, ms: number, tz?: string | null): string {
  return text.replace(/\{\{\s*date\s*\}\}/g, dateIn(ms, tz));
}

/**
 * Fill the placeholders of a schedule's title or description:
 * - `{{ date }}`: the date it is due (YYYY-MM-DD), in its timezone.
 * - `{{ time }}`: the time it is due (HH:mm), in its timezone.
 * - `{{ last_run }}`: the date the schedule last started a task, or "never".
 * Other `{{ … }}` stay as they are, so a step's own template is not touched.
 */
export function fillSchedule(text: string, at: { due: number; timezone?: string | null; lastRun?: number | null }): string {
  return text
    .replace(/\{\{\s*date\s*\}\}/g, dateIn(at.due, at.timezone))
    .replace(/\{\{\s*time\s*\}\}/g, timeIn(at.due, at.timezone))
    .replace(/\{\{\s*last_run\s*\}\}/g, at.lastRun ? dateIn(at.lastRun, at.timezone) : 'never');
}
