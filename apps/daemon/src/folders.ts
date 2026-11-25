import { existsSync, readdirSync, statSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';

/**
 * Help to choose a repo for a workspace. A web page cannot get a folder's path from the browser's own
 * picker, but the daemon runs on your machine: it can open the system's folder dialog, list folders, and
 * look for repos in the usual places.
 */

/** Folders in your home where code usually lives. */
export const CODE_FOLDERS = ['workspace', 'workspaces', 'code', 'Code', 'src', 'dev', 'Developer', 'projects', 'Projects', 'repos', 'git', 'github', 'work'];

/** Folders never worth a look: they hold packages or caches, not your repos. */
const SKIP = new Set(['node_modules', 'vendor', 'target', 'dist', 'build']);

const isRepo = (dir: string) => existsSync(join(dir, '.git'));
/** A worktree or a submodule has a .git file, not a .git folder. */
const isWorktree = (dir: string) => {
  try {
    return statSync(join(dir, '.git')).isFile();
  } catch {
    return false;
  }
};

/** The folders in a folder, without dot folders and the ones in SKIP. Empty if it cannot be read. */
function subfolders(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIP.has(e.name))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

/**
 * The repos 1 or 2 levels under the code folders in `home`, sorted. The scan never goes inside a repo, so
 * a package inside a monorepo never counts. It skips worktrees: a workspace is for the main checkout, and
 * Orstra makes its own worktrees. It stops at `max`.
 */
export function findRepos(home: string, opts: { max?: number } = {}): string[] {
  const max = opts.max ?? 200;
  const found = new Set<string>();
  const add = (p: string) => found.size < max && found.add(p);
  for (const root of CODE_FOLDERS.map((f) => join(home, f))) {
    // On a disk that ignores case, "code" and "Code" are 1 folder: see it once.
    if (!existsSync(root) || found.size >= max) continue;
    for (const a of subfolders(root)) {
      const one = join(root, a);
      if (isRepo(one)) {
        if (!isWorktree(one)) add(one);
        continue;
      }
      for (const b of subfolders(one)) if (isRepo(join(one, b)) && !isWorktree(join(one, b))) add(join(one, b));
    }
  }
  const seen = new Set<string>();
  return [...found]
    .filter((p) => {
      const key = p.toLowerCase();
      return seen.has(key) ? false : (seen.add(key), true);
    })
    .sort((a, b) => a.localeCompare(b));
}

export interface FolderList {
  path: string;
  /** The folder above, or null at the root of the disk. */
  parent: string | null;
  /** Is this folder a repo? */
  repo: boolean;
  folders: { name: string; path: string; repo: boolean }[];
}

/** The folders in `path`, for the page's own folder list. */
export function listFolders(path: string): FolderList {
  const dir = resolve(path);
  let ok = false;
  try {
    ok = statSync(dir).isDirectory();
  } catch {
    ok = false;
  }
  if (!ok) throw new Error(`${path} does not exist or is not a folder.`);
  const up = dirname(dir);
  return {
    path: dir,
    parent: up === dir ? null : up,
    repo: isRepo(dir),
    folders: subfolders(dir).map((name) => ({ name, path: join(dir, name), repo: isRepo(join(dir, name)) })),
  };
}

export type PickResult = { path: string } | { canceled: true } | { unsupported: true; error: string };
/** Runs the dialog command. `code` is -1 when the command could not start. */
export type RunPicker = (cmd: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

/** You may take your time in the dialog. After this, the daemon gives up. */
const PICK_TIMEOUT_MS = 10 * 60 * 1000;

const run: RunPicker = (cmd, args) =>
  new Promise((done) => {
    execFile(cmd, args, { timeout: PICK_TIMEOUT_MS, encoding: 'utf8' }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { code?: number | string }) | null;
      const code = !e ? 0 : typeof e.code === 'number' ? e.code : -1;
      done({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') || (e && code === -1 ? e.message : '') });
    });
  });

/**
 * macOS: `activate` puts the dialog in front of the browser. It activates osascript itself, so it needs
 * no permission to control another app.
 */
const MAC_SCRIPT = ['tell current application to activate', 'POSIX path of (choose folder with prompt "Choose the repo for this workspace")'];

let pending: Promise<PickResult> | null = null;

/**
 * Open the system's folder dialog on this machine and wait for your choice. macOS uses osascript, Linux
 * uses zenity. Anything else, or a machine with no screen, gives `unsupported`: the page then shows its
 * own folder list. ORSTRA_FOLDER_DIALOG=off does the same, for a daemon on a machine you do not sit at.
 * While a dialog is open, a second ask waits for the same answer.
 */
export function pickFolder(platform: NodeJS.Platform = process.platform, runner: RunPicker = run, env: NodeJS.ProcessEnv = process.env): Promise<PickResult> {
  if (env.ORSTRA_FOLDER_DIALOG === 'off') return Promise.resolve({ unsupported: true, error: 'The folder dialog is off (ORSTRA_FOLDER_DIALOG=off).' });
  if (pending) return pending;
  pending = pick(platform, runner).finally(() => (pending = null));
  return pending;
}

async function pick(platform: NodeJS.Platform, runner: RunPicker): Promise<PickResult> {
  let r: Awaited<ReturnType<RunPicker>>;
  if (platform === 'darwin') r = await runner('osascript', MAC_SCRIPT.flatMap((line) => ['-e', line]));
  else if (platform === 'linux') r = await runner('zenity', ['--file-selection', '--directory', '--title=Choose the repo for this workspace']);
  else return { unsupported: true, error: 'This system has no folder dialog that Orstra can open.' };

  const path = r.stdout.trim().replace(/(.)\/+$/, '$1');
  if (r.code === 0 && path) return { path };
  // osascript says "User canceled. (-128)". zenity exits with 1 and says nothing.
  if (/\(-128\)/.test(r.stderr) || (platform === 'linux' && r.code === 1 && !r.stderr.trim())) return { canceled: true };
  return { unsupported: true, error: r.stderr.trim() || 'The folder dialog did not open.' };
}
