import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { Store } from './db.ts';
import { WORKFLOW_DIRS } from './paths.ts';

export function listWorkflows(): { name: string; path: string; file: string; error?: string }[] {
  const out: { name: string; path: string; file: string; error?: string }[] = [];
  for (const dir of WORKFLOW_DIRS) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!/\.ya?ml$/.test(f)) continue;
      const path = join(dir, f);
      const m = readFileSync(path, 'utf8').match(/^name:\s*(.+)$/m);
      out.push({ name: m?.[1]?.trim() ?? f, path, file: f });
    }
  }
  return out;
}

export function resolveWorkflow(nameOrPath: string): string {
  if (existsSync(nameOrPath) && statSync(nameOrPath).isFile()) return resolve(nameOrPath);
  const hit = listWorkflows().find((w) => w.file === nameOrPath || w.file.replace(/\.ya?ml$/, '') === nameOrPath || w.name === nameOrPath);
  if (!hit) throw new Error(`No workflow called "${nameOrPath}". Put YAML files in ${WORKFLOW_DIRS.join(' or ')}.`);
  return hit.path;
}

/**
 * Tasks store the path of their workflow file. If that file is gone (workflows moved out of the repo into
 * ~/.orstra/workflows), find the file with the same name in the workflow folder.
 */
export function locateWorkflow(path: string): string {
  if (existsSync(path)) return path;
  const hit = listWorkflows().find((w) => w.file === basename(path));
  return hit?.path ?? path;
}

/** Point tasks whose stored workflow path no longer exists at the same-named file in the workflow folder. */
export function migrateWorkflowPaths(store: Store): number {
  let n = 0;
  for (const t of store.tasks()) {
    const found = locateWorkflow(t.workflow_path);
    if (found !== t.workflow_path) {
      store.updateTask(t.id, { workflow_path: found });
      n++;
    }
  }
  return n;
}
