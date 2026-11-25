import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/db.ts';
import { Runner } from '../src/runner.ts';
import type { Executors } from '../src/executors.ts';
import { ScheduleError, Schedules } from '../src/schedules.ts';
import { Triggers } from '../src/triggers.ts';
import { buildApi } from '../src/server.ts';

const HUMAN = `steps:\n  review:\n    use: human\n    question: ok?\n    on: { approved: end }\n`;
const PLAIN = `name: Plain\n${HUMAN}`;
const t = (s: string) => Date.parse(s);

/** A daemon over the database at `db`. Call it again with the same `db` to restart it. */
function daemon(db: string, files: Record<string, string>, clock: { now: number }) {
  const dir = mkdtempSync(join(tmpdir(), 'orstra-sch-'));
  const list = Object.entries(files).map(([file, yaml]) => {
    const path = join(dir, file);
    writeFileSync(path, yaml);
    return { path, file };
  });
  const store = new Store(db);
  const runner = new Runner(store, {} as Executors, { slots: 1, createWorktree: () => dir });
  const opts = { now: () => clock.now, workflows: () => list };
  const schedules = new Schedules(store, runner, opts);
  const triggers = new Triggers(store, runner, { ...opts, schedules });
  return { store, runner, schedules, triggers, dir, list };
}

const tmpDb = () => join(mkdtempSync(join(tmpdir(), 'orstra-schdb-')), 'orstra.db');

describe('imperative schedules', () => {
  it('works out the next run from the cron and the timezone', () => {
    const clock = { now: t('2026-11-25T12:00:00Z') }; // a Wednesday
    const { schedules } = daemon(':memory:', { 'plain.yaml': PLAIN }, clock);
    const { schedule, created } = schedules.create({ workflow: 'plain', cron: '0 9 * * 1-5', timezone: 'America/New_York', title: 'Standup {{ date }}' });
    expect(created).toBe(true);
    expect(schedule).toMatchObject({ kind: 'imperative', workflow: 'plain.yaml', workflowName: 'Plain', active: true, when: 'At 09:00, Monday through Friday' });
    expect(new Date(schedule.nextRunAt!).toISOString()).toBe('2026-11-25T14:00:00.000Z'); // 12:00 UTC is 07:00 in New York
  });

  it('starts 1 task when it is due, with the date in its timezone, and not again in the same due time', async () => {
    const clock = { now: t('2026-11-25T12:00:00Z') };
    const { store, schedules, triggers } = daemon(':memory:', { 'plain.yaml': PLAIN }, clock);
    const { schedule } = schedules.create({ workflow: 'plain', cron: '0 9 * * *', timezone: 'Asia/Tokyo', title: 'Standup {{ date }}' });
    await triggers.tick();
    expect(store.tasks()).toHaveLength(0);
    clock.now = schedule.nextRunAt! + 30_000;
    await triggers.tick();
    await triggers.tick();
    expect(store.tasks()).toHaveLength(1);
    // 09:00 in Tokyo on 26 Nov is 00:00 UTC on 26 Nov.
    expect(store.tasks()[0].title).toBe('Standup 2026-11-26');
    expect(store.tasks()[0].source).toBe(`schedule:${schedule.id}@${schedule.nextRunAt}`);
    const after = schedules.get(schedule.id);
    expect(after.lastTask?.id).toBe(store.tasks()[0].id);
    expect(after.lastRunAt).toBe(schedule.nextRunAt);
    expect(after.nextRunAt).toBe(schedule.nextRunAt! + 86_400_000);
  });

  it('is never made twice: the same schedule again changes the one that exists', () => {
    const { store, schedules } = daemon(':memory:', { 'plain.yaml': PLAIN }, { now: Date.now() });
    const a = schedules.create({ workflow: 'plain', cron: '0 9 * * *', title: 'One' });
    const b = schedules.create({ workflow: 'plain.yaml', cron: '0 9 * * *', title: 'Two' });
    expect(b.created).toBe(false);
    expect(b.schedule.id).toBe(a.schedule.id);
    expect(b.schedule.title).toBe('Two');
    const c = schedules.create({ workflow: 'plain', cron: '0 10 * * *', title: 'Other', dedupKey: 'mine' });
    const d = schedules.create({ workflow: 'plain', cron: '0 11 * * *', title: 'Other', dedupKey: 'mine' });
    expect(d.schedule.id).toBe(c.schedule.id);
    expect(d.schedule.cron).toBe('0 11 * * *');
    expect(store.schedules()).toHaveLength(2);
  });

  it('turned off, starts nothing; turned on again, waits for its next due time', async () => {
    const clock = { now: t('2026-11-25T12:00:00Z') };
    const { store, schedules, triggers } = daemon(':memory:', { 'plain.yaml': PLAIN }, clock);
    const { schedule } = schedules.create({ workflow: 'plain', cron: '0 * * * *', title: 'Hourly' });
    schedules.setActive(schedule.id, false);
    clock.now += 5 * 3600_000;
    await triggers.tick();
    expect(store.tasks()).toHaveLength(0);
    const on = schedules.setActive(schedule.id, true);
    expect(on.nextRunAt).toBe(t('2026-11-25T18:00:00Z'));
    await triggers.tick();
    expect(store.tasks()).toHaveLength(0);
  });

  it('refuses a wrong cron, a wrong timezone and an unknown workflow', () => {
    const { schedules } = daemon(':memory:', { 'plain.yaml': PLAIN }, { now: Date.now() });
    expect(() => schedules.create({ workflow: 'plain', cron: 'every day', title: 'x' })).toThrow(/cron/);
    expect(() => schedules.create({ workflow: 'plain', cron: '0 9 * * *', timezone: 'Mars/Base', title: 'x' })).toThrow(/not a timezone/);
    expect(() => schedules.create({ workflow: 'nope', cron: '0 9 * * *', title: 'x' })).toThrow(/No workflow/);
    expect(() => schedules.create({ workflow: 'plain', cron: '0 9 * * *', title: ' ' })).toThrow(/title/);
  });
});

describe('the inputs of a scheduled task', () => {
  it('fills {{ last_run }} in the title, and gives step prompts trigger.schedule', async () => {
    const clock = { now: t('2026-11-25T08:00:00Z') };
    const { store, runner, schedules, triggers } = daemon(':memory:', { 'plain.yaml': PLAIN }, clock);
    const { schedule } = schedules.create({ workflow: 'plain', cron: '30 9 * * *', timezone: 'Europe/Paris', title: 'Digest {{ date }} {{ time }} since {{ last_run }}' });
    clock.now = t('2026-11-25T08:31:00Z');
    await triggers.tick();
    clock.now = t('2026-11-26T08:31:00Z');
    await triggers.tick();
    const [second, first] = store.tasks();
    expect(first.title).toBe('Digest 2026-11-25 09:30 since never');
    expect(second.title).toBe('Digest 2026-11-26 09:30 since 2026-11-25');

    const ctx = (runner as any).context(second);
    expect(ctx.trigger.schedule).toEqual({ id: schedule.id, due: '2026-11-26T08:30:00.000Z', date: '2026-11-26', time: '09:30', timezone: 'Europe/Paris', last_run: '2026-11-25' });
    expect((runner as any).context(first).trigger.schedule.last_run).toBe('never');
    // A task you started yourself has no schedule facts.
    const own = runner.startTask({ workflowPath: (schedules as any).workflows()[0].path, title: 'mine' });
    expect((runner as any).context(own).trigger.schedule).toBeUndefined();
  });
});

describe('1 task per due time, across a restart', () => {
  it('a restarted daemon does not start the same due time again', async () => {
    const db = tmpDb();
    const clock = { now: t('2026-11-25T08:59:00Z') };
    const first = daemon(db, { 'plain.yaml': PLAIN }, clock);
    const { schedule } = first.schedules.create({ workflow: 'plain', cron: '0 9 * * *', title: 'Daily' });
    clock.now = t('2026-11-25T09:00:20Z');
    await first.triggers.tick();
    expect(first.store.tasks()).toHaveLength(1);
    first.store.db.close();

    const second = daemon(db, { 'plain.yaml': PLAIN }, clock);
    await second.triggers.tick();
    expect(second.store.tasks()).toHaveLength(1);
    expect(second.schedules.get(schedule.id).nextRunAt).toBe(t('2026-11-26T09:00:00Z'));
  });

  it('a crash after the task started and before the next run moved on starts no second task', async () => {
    const db = tmpDb();
    const clock = { now: t('2026-11-25T09:00:20Z') };
    const first = daemon(db, { 'plain.yaml': PLAIN }, clock);
    const { schedule } = first.schedules.create({ workflow: 'plain', cron: '0 9 * * *', title: 'Daily' });
    // Created after 09:00, so its first due time is tomorrow. Pretend the daemon died while firing today's:
    // the task exists, and next_run_at still says today.
    const due = t('2026-11-25T09:00:00Z');
    first.store.updateSchedule(schedule.id, { next_run_at: due });
    first.runner.startTask({ workflowPath: first.list[0].path, title: 'Daily', source: `schedule:${schedule.id}@${due}` });
    first.store.db.close();

    const second = daemon(db, { 'plain.yaml': PLAIN }, clock);
    await second.triggers.tick();
    expect(second.store.tasks()).toHaveLength(1);
    const after = second.schedules.get(schedule.id);
    expect(after.lastTask?.id).toBe(second.store.tasks()[0].id);
    expect(after.nextRunAt).toBe(t('2026-11-26T09:00:00Z'));
  });

  it('due times missed while the daemon was off start 1 task, then it waits for the next one', async () => {
    const db = tmpDb();
    const clock = { now: t('2026-11-25T08:00:00Z') };
    const first = daemon(db, { 'plain.yaml': PLAIN }, clock);
    const { schedule } = first.schedules.create({ workflow: 'plain', cron: '0 9 * * *', title: 'Daily {{ date }}' });
    first.store.db.close();

    clock.now = t('2026-11-28T10:00:00Z'); // off for 4 due times
    const second = daemon(db, { 'plain.yaml': PLAIN }, clock);
    await second.triggers.tick();
    await second.triggers.tick();
    expect(second.store.tasks()).toHaveLength(1);
    // It runs for the first missed due time it had stored, then jumps past now.
    expect(second.store.tasks()[0].title).toBe('Daily 2026-11-25');
    expect(second.schedules.get(schedule.id).nextRunAt).toBe(t('2026-11-29T09:00:00Z'));
  });
});

describe('declarative schedules', () => {
  const DOGFOOD = `name: Dogfood\ntriggers:\n  - schedule: { cron: "0 9 * * 1-5", timezone: Europe/London, title: "Dogfood {{ date }}" }\n${HUMAN}`;

  it('come from the workflow file, with a next run', async () => {
    const clock = { now: t('2026-11-25T12:00:00Z') };
    const { schedules } = daemon(':memory:', { 'dogfood.yaml': DOGFOOD }, clock);
    const [s] = schedules.list();
    expect(s).toMatchObject({ id: 'yaml:dogfood.yaml#0', kind: 'declarative', cron: '0 9 * * 1-5', timezone: 'Europe/London', active: true });
    expect(s.workflowPath).toMatch(/dogfood\.yaml$/);
    expect(new Date(s.nextRunAt!).toISOString()).toBe('2026-11-26T09:00:00.000Z');
  });

  it('cannot be changed, turned off or deleted through Schedules: edit the workflow file', () => {
    const { schedules } = daemon(':memory:', { 'dogfood.yaml': DOGFOOD }, { now: Date.now() });
    const [s] = schedules.list();
    for (const act of [() => schedules.update(s.id, { title: 'x' }), () => schedules.setActive(s.id, false), () => schedules.setActive(s.id, true), () => schedules.remove(s.id)]) {
      let err: unknown;
      try {
        act();
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ScheduleError);
      expect((err as ScheduleError).status).toBe(409);
      expect((err as Error).message).toMatch(/Edit the workflow file/);
    }
    expect(schedules.get(s.id)).toMatchObject({ title: 'Dogfood {{ date }}', active: true });
  });

  it('cannot be changed through the API, and an imperative one can', async () => {
    const clock = { now: t('2026-11-25T12:00:00Z') };
    const d = daemon(':memory:', { 'dogfood.yaml': DOGFOOD, 'plain.yaml': PLAIN }, clock);
    const api = buildApi(d.store, d.runner, undefined, d.triggers);
    const server: Server = createServer((req, res) => void api(req, res).then((done) => done || res.writeHead(404).end()));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/schedules`;
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, body: (await res.json()) as any };
    };
    try {
      const list = await call('GET', '');
      const decl = list.body.find((s: any) => s.kind === 'declarative');
      const enc = encodeURIComponent(decl.id);
      for (const [method, path, body] of [['PATCH', `/${enc}`, { title: 'x' }], ['POST', `/${enc}/deactivate`], ['POST', `/${enc}/activate`], ['DELETE', `/${enc}`]] as const) {
        const r = await call(method, path, body);
        expect(r.status).toBe(409);
        expect(r.body.error).toMatch(/Edit the workflow file/);
      }

      const made = await call('POST', '', { workflow: 'plain', cron: '30 8 * * *', timezone: 'UTC', title: 'Mine' });
      expect(made.status).toBe(201);
      const sid = encodeURIComponent(made.body.schedule.id);
      expect((await call('PATCH', `/${sid}`, { cron: '0 7 * * *' })).body.when).toBe('At 07:00');
      expect((await call('POST', `/${sid}/deactivate`)).body.active).toBe(false);
      expect((await call('POST', `/${sid}/activate`)).body.active).toBe(true);
      expect((await call('DELETE', `/${sid}`)).status).toBe(200);
      expect((await call('GET', `/${sid}`)).status).toBe(404);
      expect((await call('GET', `/preview?cron=${encodeURIComponent('0 9 * * 1-5')}&timezone=UTC`)).body.when).toBe('At 09:00, Monday through Friday');
    } finally {
      server.close();
    }
  });

  it('a changed cron in the file gets a new next run; a trigger that left the file loses its row', () => {
    const clock = { now: t('2026-11-25T12:00:00Z') };
    const d = daemon(':memory:', { 'dogfood.yaml': DOGFOOD }, clock);
    d.schedules.sync();
    writeFileSync(d.list[0].path, DOGFOOD.replace('0 9 * * 1-5', '0 18 * * *'));
    d.schedules.sync();
    expect(new Date(d.schedules.get('yaml:dogfood.yaml#0').nextRunAt!).toISOString()).toBe('2026-11-25T18:00:00.000Z');
    writeFileSync(d.list[0].path, `name: Dogfood\n${HUMAN}`);
    d.schedules.sync();
    expect(d.store.schedules()).toHaveLength(0);
  });

  it('keeps the time an every: schedule last fired from before schedules had rows', () => {
    const clock = { now: t('2026-11-25T12:00:00Z') };
    const db = tmpDb();
    const pre = new Store(db);
    pre.set('schedule:dogfood.yaml#0', String(t('2026-11-25T02:00:00Z')));
    pre.db.close();
    const d = daemon(db, { 'dogfood.yaml': `name: Dogfood\ntriggers:\n  - schedule: { every: 1d, title: Dogfood }\n${HUMAN}` }, clock);
    const [s] = d.schedules.list();
    expect(s).toMatchObject({ everyMinutes: 1440, when: 'Every 1 day', lastRunAt: t('2026-11-25T02:00:00Z'), nextRunAt: t('2026-11-26T02:00:00Z') });
  });
});
