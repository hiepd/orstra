import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import { parseWorkflow, triggerFileFromEntry } from '@orstra/core';
import type { Store } from './db.ts';
import { TRIGGERS_DIR } from './paths.ts';

/**
 * Trigger files: 1 declarative trigger per YAML file in the trigger folder, naming the workflow it
 * starts. A workflow is a recipe; it does not list what starts it.
 */

export type FileRef = { path: string; file: string };

export function listTriggerFiles(dir = TRIGGERS_DIR): FileRef[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort()
    .map((file) => ({ path: join(dir, file), file }));
}

const HEADER = (from: string) => `# Moved here from the triggers: list of ${from}. This file is the trigger; its name is its id.\n`;

/** `base.yaml`, else `base-2.yaml`, … A file that already holds `content` is reused, so a second run writes no copy. */
function freeName(dir: string, base: string, content: string): string {
  for (let n = 1; ; n++) {
    const name = n === 1 ? `${base}.yaml` : `${base}-${n}.yaml`;
    const path = join(dir, name);
    if (!existsSync(path) || readFileSync(path, 'utf8') === content) return name;
  }
}

/** `<file>.bak-YYYYMMDD`, else with the time too, so an earlier backup is never overwritten. */
function backupPath(path: string, now: number): string {
  const d = new Date(now).toISOString();
  const day = `${path}.bak-${d.slice(0, 10).replace(/-/g, '')}`;
  return existsSync(day) ? `${day}-${d.slice(11, 19).replace(/:/g, '')}` : day;
}

/**
 * Move every `triggers:` list out of the workflow files: each entry becomes a trigger file, and the
 * list leaves the workflow file, which keeps a `.bak` copy. A schedule keeps its state: its row moves
 * from the old id (`yaml:<workflow file>#<n>`) to the new one (`file:<trigger file>`), and the time an
 * interval last fired, from before schedules had rows, moves with it.
 *
 * It runs on every check, so a `triggers:` list someone writes later moves too. A workflow file that
 * does not parse is left alone: the Workflows screen shows its error. Returns the trigger files written.
 */
export function migrateWorkflowTriggers(store: Store, workflows: FileRef[], dir = TRIGGERS_DIR, now = Date.now()): string[] {
  const written: string[] = [];
  for (const w of workflows) {
    let source: string;
    try {
      source = readFileSync(w.path, 'utf8');
      if (!/^triggers\s*:/m.test(source)) continue;
      parseWorkflow(source);
    } catch {
      continue;
    }
    const doc = parseDocument(source);
    if (doc.errors.length) continue;
    const list = (doc.toJS() as { triggers?: unknown }).triggers;
    if (!Array.isArray(list)) continue;
    const stem = w.file.replace(/\.ya?ml$/, '');
    mkdirSync(dir, { recursive: true });
    list.forEach((entry: Record<string, any>, i: number) => {
      const kind = entry.linear ? 'linear' : 'schedule';
      const content = HEADER(w.file) + triggerFileFromEntry(stem, entry);
      const name = freeName(dir, list.length > 1 ? `${stem}-${kind}-${i + 1}` : `${stem}-${kind}`, content);
      writeFileSync(join(dir, name), content);
      written.push(name);
      if (kind !== 'schedule') return;
      const oldId = `yaml:${w.file}#${i}`;
      const newId = `file:${name}`;
      if (store.schedule(oldId) && !store.schedule(newId)) store.renameSchedule(oldId, newId);
      const legacyKey = `schedule:${w.file}#${i}`;
      const legacy = Number(store.get(legacyKey) ?? 0);
      if (legacy) {
        store.set(`schedule-last:${newId}`, String(legacy));
        store.set(legacyKey, '0');
      }
    });
    copyFileSync(w.path, backupPath(w.path, now));
    doc.delete('triggers');
    // lineWidth 0: change nothing but the list. The writer would otherwise wrap long lines at 80.
    writeFileSync(w.path, doc.toString({ lineWidth: 0 }));
    console.log(`Moved ${list.length} trigger(s) out of ${w.file} into ${dir}.`);
  }
  return written;
}
