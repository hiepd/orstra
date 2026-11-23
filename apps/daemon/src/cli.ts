import { parseArgs } from 'node:util';
import { DB_PATH, PORT, ensureDirs } from './paths.ts';

const HELP = `orstra — a local software factory

  orstra serve                         start the daemon and UI (http://localhost:${PORT})
  orstra run <workflow> --title "…"    start a task (needs the daemon running)
        [--description "…"] [--ref HUB-1] [--repo ~/path/to/repo]
  orstra tasks                         list tasks
  orstra sessions                      list agent sessions (running, queued, last 24h)
  orstra workflows                     list workflow files
`;

const base = `http://127.0.0.1:${PORT}`;

async function api(path: string, init?: RequestInit) {
  let res: Response;
  try {
    res = await fetch(base + path, { ...init, headers: { 'content-type': 'application/json' } });
  } catch {
    throw new Error(`The daemon isn't running. Start it with: npm run serve`);
  }
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? res.statusText);
  return body;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { title: { type: 'string' }, description: { type: 'string' }, ref: { type: 'string' }, repo: { type: 'string' } },
  });

  switch (cmd) {
    case 'serve': {
      ensureDirs();
      const { Store } = await import('./db.ts');
      const { Runner } = await import('./runner.ts');
      const { realExecutors } = await import('./executors.ts');
      const { createWorktree } = await import('./worktree.ts');
      const { startServer } = await import('./server.ts');
      const store = new Store(DB_PATH);
      const runner = new Runner(store, realExecutors, { slots: Number(process.env.ORSTRA_SLOTS ?? 4), createWorktree });
      runner.recover();
      startServer(store, runner, PORT);
      console.log(`Orstra is running at http://localhost:${PORT}  (data: ${DB_PATH})`);
      return;
    }
    case 'run': {
      if (!positionals[0] || !values.title) throw new Error('Usage: orstra run <workflow> --title "…"');
      const t = await api('/api/tasks', { method: 'POST', body: JSON.stringify({ workflow: positionals[0], ...values }) });
      console.log(`Started ${t.id}: ${t.title} (${t.workflow}) → http://localhost:${PORT}/#/tasks/${t.id}`);
      return;
    }
    case 'tasks': {
      for (const t of await api('/api/tasks')) console.log(`${t.id}  ${t.status.padEnd(9)}  ${(t.currentStepTitle ?? '—').padEnd(20)}  ${t.ref ? t.ref + ' ' : ''}${t.title}`);
      return;
    }
    case 'sessions': {
      for (const s of await api('/api/sessions')) console.log(`${s.status.padEnd(8)}  ${s.task.ref ?? s.task.id}  ${s.stepTitle} #${s.attempt}  ${s.agent ?? 'gate'}  ${s.now ?? ''}`);
      return;
    }
    case 'workflows': {
      const { listWorkflows } = await import('./server.ts');
      for (const w of listWorkflows()) console.log(`${w.file.padEnd(24)} ${w.name}`);
      return;
    }
    default:
      console.log(HELP);
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
