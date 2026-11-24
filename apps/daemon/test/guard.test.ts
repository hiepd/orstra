import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { refuseReason } from '../src/guard.ts';
import { Store } from '../src/db.ts';
import { Runner } from '../src/runner.ts';
import { startServer } from '../src/server.ts';
import type { Executors } from '../src/executors.ts';

const opts = { port: 4317, uiPorts: [5317] };
const json = { 'content-type': 'application/json' };

describe('refuseReason', () => {
  it('lets the UI, the dev UI and local processes through', () => {
    expect(refuseReason('POST', { host: 'localhost:4317', origin: 'http://localhost:4317', ...json }, opts)).toBeNull();
    expect(refuseReason('POST', { host: '127.0.0.1:4317', origin: 'http://localhost:5317', ...json }, opts)).toBeNull();
    expect(refuseReason('POST', { host: '127.0.0.1:4317', ...json }, opts)).toBeNull();
    expect(refuseReason('GET', { host: '[::1]:4317' }, opts)).toBeNull();
  });

  it('refuses a page on another site', () => {
    expect(refuseReason('POST', { host: 'localhost:4317', origin: 'https://evil.example', ...json }, opts)).toMatch(/Origin/);
    expect(refuseReason('POST', { host: 'localhost:4317', origin: 'null', ...json }, opts)).toMatch(/Origin/);
    expect(refuseReason('GET', { host: 'localhost:4317', 'sec-fetch-site': 'cross-site' }, opts)).toMatch(/another site/);
  });

  it('refuses a DNS-rebinding host', () => {
    expect(refuseReason('GET', { host: 'evil.example:4317' }, opts)).toMatch(/Host/);
    expect(refuseReason('GET', {}, opts)).toMatch(/Host/);
  });

  it('refuses a change without a JSON content type, so no simple cross-site POST gets in', () => {
    expect(refuseReason('POST', { host: 'localhost:4317', 'content-type': 'text/plain' }, opts)).toMatch(/content-type/);
    expect(refuseReason('POST', { host: 'localhost:4317' }, opts)).toMatch(/content-type/);
  });

  it('accepts a host from ORSTRA_ALLOWED_HOSTS', () => {
    expect(refuseReason('GET', { host: 'box.lan:4317' }, { ...opts, extraHosts: ['box.lan:4317'] })).toBeNull();
  });
});

describe('the server', () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orstra-guard-'));
    writeFileSync(join(dir, 'wf.yaml'), 'name: X\nsteps:\n  a:\n    use: human\n    question: ok?\n    on: { approved: end }\n');
    const exec = {} as Executors;
    const store = new Store(':memory:');
    const runner = new Runner(store, exec, { slots: 1, createWorktree: () => dir });
    server = startServer(store, runner, 0);
    await new Promise((r) => server.once('listening', r));
    const port = (server.address() as AddressInfo).port;
    base = `http://127.0.0.1:${port}`;
  });
  afterAll(() => server.close());

  it('answers a request from Node fetch (the CLI)', async () => {
    const res = await fetch(`${base}/api/tasks`);
    expect(res.status).toBe(200);
  });

  it('refuses a text/plain POST, the kind a page can send without a preflight', async () => {
    const res = await fetch(`${base}/api/tasks/x/stop`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
    expect(res.status).toBe(403);
  });
});
