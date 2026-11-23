import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
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
