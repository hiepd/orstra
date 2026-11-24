import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DevServers, defaultCommand, urlFromOutput } from '../src/devServers.ts';

const servers = new DevServers();
afterAll(() => servers.stopAll());

const until = (fn: () => boolean, ms = 10_000) =>
  new Promise<void>((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => (fn() ? resolve() : Date.now() - t0 > ms ? reject(new Error('timed out')) : setTimeout(tick, 25));
    tick();
  });

describe('urlFromOutput', () => {
  it('finds the local URL that dev servers print', () => {
    expect(urlFromOutput('  ➜  Local:   http://localhost:5173/\n  ➜  Network: use --host')).toBe('http://localhost:5173/');
    expect(urlFromOutput('ready on http://0.0.0.0:3000')).toBe('http://localhost:3000');
    expect(urlFromOutput('listening at http://[::]:8080/app')).toBe('http://localhost:8080/app');
    expect(urlFromOutput('\u001b[32m➜\u001b[39m  Local: \u001b[36mhttp://127.0.0.1:\u001b[1m4000\u001b[22m/\u001b[39m')).toBe('http://127.0.0.1:4000/');
    expect(urlFromOutput('compiling…')).toBeNull();
    expect(urlFromOutput('docs at https://vitejs.dev/guide')).toBeNull();
  });
});

describe('defaultCommand', () => {
  const pkg = (scripts?: Record<string, string>) => {
    const d = mkdtempSync(join(tmpdir(), 'orstra-dev-'));
    if (scripts) writeFileSync(join(d, 'package.json'), JSON.stringify({ scripts }));
    return d;
  };
  it('picks dev, then start', () => {
    expect(defaultCommand(pkg({ dev: 'vite', start: 'node x' }))).toBe('npm run dev');
    expect(defaultCommand(pkg({ start: 'node x' }))).toBe('npm start');
    expect(defaultCommand(pkg({ test: 'vitest' }))).toBeNull();
    expect(defaultCommand(pkg())).toBeNull();
  });
});

describe('DevServers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orstra-dev-'));

  it('starts a command with a free PORT, finds its URL, and stops it', async () => {
    const cmd = `node -e "console.log('Local: http://localhost:'+process.env.PORT+'/'); setInterval(()=>{},1000)"`;
    const first = await servers.start('t1', dir, cmd);
    expect(first.state).toBe('starting');
    await until(() => servers.status('t1').state === 'running');
    const v = servers.status('t1');
    expect(v.url).toBe(`http://localhost:${v.port}/`);
    expect(v.command).toBe(cmd);
    const pid = servers.pid('t1')!;
    await servers.stop('t1');
    expect(servers.status('t1').state).toBe('stopped');
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('reports a command that exits at once, with its code and log', async () => {
    await servers.start('t2', dir, 'echo boom; exit 3');
    await until(() => servers.status('t2').state === 'exited');
    const v = servers.status('t2');
    expect(v.exitCode).toBe(3);
    expect(v.log).toContain('boom');
  });

  it('says stopped, with the suggested command, before a start', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }));
    expect(servers.status('never', dir)).toMatchObject({ state: 'stopped', suggested: 'npm run dev', url: null });
  });
});
