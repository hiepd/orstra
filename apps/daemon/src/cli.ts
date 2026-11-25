import { parseArgs } from 'node:util';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COS_DIR, DB_PATH, HOME, LOCK_PATH, PORT, REPO_ROOT, SLOTS, TSX, ensureDirs } from './paths.ts';

const HELP = `orstra — a local software factory

  orstra serve                         start the daemon and UI (http://localhost:${PORT})
  orstra run <workflow> --title "…"    start a task (needs the daemon running)
        [--workspace orstra] [--base main] [--description "…"] [--ref HUB-1]
        [--repo ~/path/to/repo]        a repo path used once, for a task with no workspace
  orstra tasks                         list tasks
  orstra workspaces                    list workspaces
  orstra sessions                      list agent sessions (running, queued, last 24h)
  orstra workflows                     list workflow files
  orstra rebuild [task-id]             work every task's state out from its runs again
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
    options: { title: { type: 'string' }, description: { type: 'string' }, ref: { type: 'string' }, repo: { type: 'string' }, workspace: { type: 'string' }, base: { type: 'string' } },
  });

  switch (cmd) {
    case 'serve': {
      ensureDirs();
      // One daemon per home folder. Two would both start every queued run, so each step would
      // happen twice in the same worktree.
      const { takeLock } = await import('./lock.ts');
      const lock = takeLock(LOCK_PATH, PORT);
      if (!lock.ok) {
        console.error(`Orstra already runs on this data folder: http://localhost:${lock.holder.port} (pid ${lock.holder.pid}).`);
        console.error(`Stop it first, or point this one somewhere else with ORSTRA_HOME.`);
        process.exit(1);
      }
      const { Store } = await import('./db.ts');
      const { Runner, defaultTimeoutsFromEnv } = await import('./runner.ts');
      const { realExecutors } = await import('./executors.ts');
      const { createWorktree } = await import('./worktree.ts');
      const { startServer } = await import('./server.ts');
      const store = new Store(DB_PATH);
      const { migrateWorkflowPaths } = await import('./workflows.ts');
      const moved = migrateWorkflowPaths(store);
      if (moved) console.log(`Re-pointed ${moved} task(s) at their workflow in the workflow folder.`);
      const runner = new Runner(store, realExecutors, { slots: SLOTS, createWorktree, defaultTimeoutMs: defaultTimeoutsFromEnv() });
      runner.recover();

      // The chief of staff: Claude Code with Orstra's tools (served by cos-mcp.ts) and every tool of its own.
      const { ChiefOfStaff } = await import('./cos.ts');
      const { cosToolArgs } = await import('./cos-tools.ts');
      const { makeViews } = await import('./server.ts');
      const mcpConfig = join(COS_DIR, 'mcp.json');
      const mcpScript = fileURLToPath(new URL('./cos-mcp.ts', import.meta.url));
      writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { orstra: { type: 'stdio', command: TSX, args: [mcpScript], env: { ORSTRA_PORT: String(PORT) } } } }, null, 2));
      const cos = new ChiefOfStaff(store, runner, realExecutors, makeViews(store, runner), {
        cwd: COS_DIR,
        model: process.env.ORSTRA_COS_MODEL,
        // Its workspace: ~/.orstra (the database, the workflow files, the task worktrees) and this checkout.
        // The files you attach live under ~/.orstra/cos/attachments/, so they are inside it.
        toolArgs: cosToolArgs({ mcpConfig, dirs: [HOME, REPO_ROOT] }),
      });
      // Triggers: Linear issues with a label, and schedules. Checked every ORSTRA_TRIGGER_INTERVAL_S (60) seconds.
      const { Triggers, linearClient } = await import('./triggers.ts');
      const triggers = new Triggers(store, runner, { linear: process.env.LINEAR_API_KEY ? linearClient(process.env.LINEAR_API_KEY) : null });
      // The side viewer's shells and dev servers. They end with the daemon: nothing outlives what started it.
      const { Terminals } = await import('./terminals.ts');
      const { DevServers } = await import('./devServers.ts');
      const terminals = new Terminals();
      const devServers = new DevServers();
      const stopChildren = () => (terminals.closeAll(), devServers.stopAll());
      process.on('exit', () => { stopChildren(); lock.release(); });
      /**
       * Go down on purpose: close every agent session first, so each agent stops at the end of its
       * current action and leaves no process behind. A crash skips this, and `recover()` sweeps.
       */
      let stopping = false;
      const stop = async () => {
        if (stopping) return;
        stopping = true;
        stopChildren();
        await runner.shutdown();
        lock.release();
        process.exit(0);
      };
      for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => void stop());
      startServer(store, runner, PORT, cos, triggers, { terminals, devServers });
      triggers.start(Number(process.env.ORSTRA_TRIGGER_INTERVAL_S ?? 60) * 1000);
      cos.start();
      console.log(`Orstra is running at http://localhost:${PORT}  (data: ${DB_PATH})`);
      return;
    }
    case 'run': {
      if (!positionals[0] || !values.title) throw new Error('Usage: orstra run <workflow> --title "…"');
      const { base: baseBranch, ...rest } = values;
      const t = await api('/api/tasks', { method: 'POST', body: JSON.stringify({ workflow: positionals[0], ...rest, baseBranch }) });
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
    case 'rebuild': {
      const { changed } = await api('/api/rebuild', { method: 'POST', body: JSON.stringify({ taskId: positionals[0] }) });
      for (const c of changed) console.log(`${c.taskId}  ${c.from} → ${c.to}`);
      console.log(changed.length ? `${changed.length} task${changed.length === 1 ? '' : 's'} changed` : 'Every task already said the right thing.');
      break;
    }
    case 'workspaces': {
      for (const w of await api('/api/workspaces')) console.log(`${w.name.padEnd(20)} ${w.repoPath}  (${w.baseBranch}${w.subdir ? `, ${w.subdir}` : ''})`);
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
