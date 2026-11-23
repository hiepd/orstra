import { parseArgs } from 'node:util';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COS_DIR, DB_PATH, PORT, SLOTS, TSX, ensureDirs } from './paths.ts';

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
      const { migrateWorkflowPaths } = await import('./workflows.ts');
      const moved = migrateWorkflowPaths(store);
      if (moved) console.log(`Re-pointed ${moved} task(s) at their workflow in the workflow folder.`);
      const runner = new Runner(store, realExecutors, { slots: SLOTS, createWorktree });
      runner.recover();

      // The chief of staff: Claude Code with Orstra's tools (served by cos-mcp.ts) and no built-in tools.
      const { ChiefOfStaff } = await import('./cos.ts');
      const { COS_PROMPT } = await import('./cos-tools.ts');
      const { makeViews } = await import('./server.ts');
      const mcpConfig = join(COS_DIR, 'mcp.json');
      const mcpScript = fileURLToPath(new URL('./cos-mcp.ts', import.meta.url));
      writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { orstra: { type: 'stdio', command: TSX, args: [mcpScript], env: { ORSTRA_PORT: String(PORT) } } } }, null, 2));
      const cos = new ChiefOfStaff(store, runner, realExecutors, makeViews(store, runner), {
        cwd: COS_DIR,
        model: process.env.ORSTRA_COS_MODEL,
        toolArgs: ['--tools', '', '--mcp-config', mcpConfig, '--strict-mcp-config', '--allowedTools', 'mcp__orstra', '--permission-mode', 'default', '--append-system-prompt', COS_PROMPT],
      });
      startServer(store, runner, PORT, cos);
      cos.start();
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
