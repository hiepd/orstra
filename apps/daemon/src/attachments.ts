import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';

/**
 * A file you added to a chat message. The agent opens it at `path`, which is relative to the task's
 * worktree, so its Read tool needs no permission answer.
 *
 * An **attachment** is a file you add. An **artifact** is a file a step produces. Both live under
 * `.orstra/` in the worktree, in their own folder.
 */
export interface Attachment {
  name: string;
  /** Relative to the worktree: `.orstra/attachments/<id>/<name>`. */
  path: string;
  bytes: number;
  mime: string;
}

/** The folder Orstra owns inside a worktree. Never committed; see `excludeFromGit`. */
export const ORSTRA_DIR = '.orstra';
/** Files you add in chat. `.orstra/artifacts/` is kept for the files a step produces. */
export const ATTACH_DIR = `${ORSTRA_DIR}/attachments`;

/**
 * Where one chat keeps its files. `base` is the folder the agent works in, so a path relative to it
 * is a path the agent can open. `dir` is the attachments folder under it.
 *
 * A task worktree is the user's repository, so the files hide under `.orstra/` and the folder goes
 * into the repository's exclude file. The chief of staff folder is Orstra's own and holds no git.
 */
export interface AttachStore {
  base: string;
  dir: string;
  /** true when `base` is inside a git repository that must not pick the files up. */
  git: boolean;
}

export const taskFiles = (worktree: string): AttachStore => ({ base: worktree, dir: ATTACH_DIR, git: true });
export const cosFiles = (cosDir: string): AttachStore => ({ base: cosDir, dir: 'attachments', git: false });
/** One file at most this big. Base64 in a JSON body makes 10 MB about 13.4 MB on the wire. */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
/** All the files of one message at most this big. */
export const MAX_MESSAGE_BYTES = 25 * 1024 * 1024;
/** This many files in one message at most. */
export const MAX_FILES = 5;

const MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.avif': 'image/avif', '.bmp': 'image/bmp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.pdf': 'application/pdf', '.json': 'application/json', '.csv': 'text/csv', '.html': 'text/html',
  '.txt': 'text/plain', '.log': 'text/plain', '.md': 'text/markdown', '.yaml': 'text/yaml', '.yml': 'text/yaml',
  '.ts': 'text/plain', '.tsx': 'text/plain', '.js': 'text/plain', '.jsx': 'text/plain', '.py': 'text/plain',
  '.sh': 'text/plain', '.sql': 'text/plain', '.diff': 'text/plain', '.patch': 'text/plain',
  '.zip': 'application/zip', '.gz': 'application/gzip', '.mp4': 'video/mp4', '.mov': 'video/quicktime',
};

/** The type Orstra serves the file as, read from its name. The browser's own guess is never trusted. */
export function mimeOf(name: string): string {
  return MIME[extname(name).toLowerCase()] ?? 'application/octet-stream';
}

export const isImage = (mime: string) => mime.startsWith('image/');

/** A cap as a round number of MB, for a sentence you can show. */
export const mb = (n: number) => `${Math.round(n / (1024 * 1024))} MB`;

/** "184 KB", "2.4 MB". */
export function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** The name as Orstra stores it: no folders, no surprises, 80 characters at most. */
export function safeName(raw: unknown): string {
  const cleaned = basename(String(raw ?? ''))
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+/, '');
  if (!cleaned) return 'file';
  if (cleaned.length <= 80) return cleaned;
  const ext = extname(cleaned).slice(0, 10);
  return cleaned.slice(0, 80 - ext.length) + ext;
}

export const attachRoot = (store: AttachStore) => resolve(join(store.base, store.dir));

/**
 * The absolute path of a file inside the attachments folder, or null when the path leaves it.
 * An absolute path, a `..` segment and a symlink out of the folder all give null.
 */
export function attachPath(store: AttachStore, relPath: unknown): string | null {
  const root = attachRoot(store);
  const abs = resolve(store.base, String(relPath ?? ''));
  if (!abs.startsWith(root + sep)) return null;
  try {
    const real = realpathSync(abs);
    if (!real.startsWith(realpathSync(root) + sep)) return null;
  } catch {
    // Not on disk yet (or the folder is absent): the text check above already held.
  }
  return abs;
}

function excludeFile(worktree: string): string | null {
  try {
    const out = execFileSync('git', ['-C', worktree, 'rev-parse', '--git-path', 'info/exclude'], { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).trim();
    // In a linked worktree git maps info/exclude to the shared git folder, which is the file it reads.
    return out ? resolve(worktree, out) : null;
  } catch {
    return null;
  }
}

/**
 * Keep `.orstra/` out of git through the repository's own exclude file. The user's `.gitignore` is
 * never touched, so no attachment can reach their branch or their pull request.
 */
export function excludeFromGit(worktree: string) {
  const file = excludeFile(worktree);
  if (!file) return;
  const line = `/${ORSTRA_DIR}/`;
  try {
    const now = existsSync(file) ? readFileSync(file, 'utf8') : '';
    if (now.split('\n').some((l) => l.trim() === line)) return;
    mkdirSync(dirname(file), { recursive: true });
    const head = now && !now.endsWith('\n') ? now + '\n' : now;
    writeFileSync(file, `${head}# Orstra: the files you add in chat and the files a step produces. Do not commit them.\n${line}\n`);
  } catch {
    // A read-only git folder is no reason to drop the message.
  }
}

/** Write one pasted, dropped or picked file into the chat's folder. Throws a sentence you can show. */
export function saveAttachment(store: AttachStore, input: { name?: unknown; data?: unknown }): Attachment {
  const buf = Buffer.from(String(input.data ?? ''), 'base64');
  if (!buf.length) throw new Error('That file is empty.');
  if (buf.length > MAX_FILE_BYTES) throw new Error(`That file is ${humanBytes(buf.length)}. The cap is ${mb(MAX_FILE_BYTES)} per file.`);
  const name = safeName(input.name);
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const dir = join(attachRoot(store), id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), buf);
  if (store.git) excludeFromGit(store.base);
  return { name, path: `${store.dir}/${id}/${name}`, bytes: buf.length, mime: mimeOf(name) };
}

/** The bytes behind a path, for the thumbnail and the download. Null when the path is not ours. */
export function readAttachment(store: AttachStore, relPath: unknown): { body: Buffer; mime: string; name: string } | null {
  const abs = attachPath(store, relPath);
  if (!abs || !existsSync(abs) || !statSync(abs).isFile()) return null;
  return { body: readFileSync(abs), mime: mimeOf(abs), name: basename(abs) };
}

/**
 * The files a message claims, checked against the disk. The size and the type come from the file
 * itself, so the browser cannot name a path or a size that Orstra did not write.
 */
export function checkAttachments(store: AttachStore, raw: unknown): Attachment[] {
  if (!Array.isArray(raw) || !raw.length) return [];
  if (raw.length > MAX_FILES) throw new Error(`${raw.length} files in 1 message. The cap is ${MAX_FILES}.`);
  const files: Attachment[] = [];
  let total = 0;
  for (const f of raw) {
    const rel = typeof f === 'string' ? f : f?.path;
    const abs = attachPath(store, rel);
    if (!abs || !existsSync(abs) || !statSync(abs).isFile()) throw new Error('That file is no longer there. Add it again.');
    const bytes = statSync(abs).size;
    total += bytes;
    if (bytes > MAX_FILE_BYTES) throw new Error(`${basename(abs)} is ${humanBytes(bytes)}. The cap is ${mb(MAX_FILE_BYTES)} per file.`);
    if (total > MAX_MESSAGE_BYTES) throw new Error(`Those files are ${humanBytes(total)} together. The cap is ${mb(MAX_MESSAGE_BYTES)} per message.`);
    files.push({ name: basename(abs), path: String(rel).replace(/\\/g, '/'), bytes, mime: mimeOf(abs) });
  }
  return files;
}

/**
 * The Claude Code permission rule that lets a session open the files you attached, and nothing else.
 * A rule is 1 argv entry, so a folder with a space in it stays whole. `//` starts an absolute path.
 */
export const readRule = (store: AttachStore) => `Read(/${attachRoot(store)}/**)`;

/** The lines Orstra adds to your message, so the agent knows where to look. */
export function filesBlock(files: Attachment[]): string {
  return [
    `I attached ${files.length === 1 ? '1 file' : `${files.length} files`}. Read ${files.length === 1 ? 'it' : 'them'} from ${files.length === 1 ? 'this path' : 'these paths'}, relative to your working folder:`,
    ...files.map((f) => `- ${f.path} (${f.mime}, ${humanBytes(f.bytes)})`),
  ].join('\n');
}

/** Your text as the agent receives it: unchanged when you attached nothing. */
export function withFiles(text: string, files: Attachment[]): string {
  if (!files.length) return text;
  return text.trim() ? `${text}\n\n${filesBlock(files)}` : filesBlock(files);
}
