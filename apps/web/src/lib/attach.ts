import { api, cosFileUrl, fileUrl, type ChatFile } from '../api';

/** Which chat a file belongs to. Each one keeps its files in the folder its agent works in. */
export type AttachTo = { kind: 'task'; taskId: string } | { kind: 'cos' };

// The same caps as apps/daemon/src/attachments.ts. The daemon checks them again.
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_MESSAGE_BYTES = 25 * 1024 * 1024;
export const MAX_FILES = 5;

export const isImage = (mime: string) => mime.startsWith('image/');

/** Where the browser reads the bytes of one attached file. */
export const urlOf = (to: AttachTo, path: string) => (to.kind === 'cos' ? cosFileUrl(path) : fileUrl(to.taskId, path));

/** "184 KB", "2.4 MB". */
export function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const MB = (n: number) => `${Math.round(n / (1024 * 1024))} MB`;

/** The bytes of a file as base64, in chunks, because one spread of 10 MB blows the call stack. */
async function base64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** A clipboard paste, a drop or a file picker gives a FileList. A screenshot arrives this way. */
export const filesOf = (list: FileList | null | undefined): File[] => (list ? Array.from(list) : []);

/**
 * Put picked files in the chat's folder, one call each. Returns what went in and 1 sentence per
 * file that did not, so nothing fails without a word to you.
 */
export async function upload(to: AttachTo, picked: File[], already: ChatFile[]): Promise<{ added: ChatFile[]; errors: string[] }> {
  const added: ChatFile[] = [];
  const errors: string[] = [];
  let count = already.length;
  let total = already.reduce((n, f) => n + f.bytes, 0);

  for (const file of picked) {
    const name = file.name || 'pasted-file';
    if (count >= MAX_FILES) {
      errors.push(`${name} did not go in. A message takes ${MAX_FILES} files at most.`);
      continue;
    }
    if (file.size === 0) {
      errors.push(`${name} is empty.`);
      continue;
    }
    if (file.size > MAX_FILE_BYTES) {
      errors.push(`${name} is ${humanBytes(file.size)}. The cap is ${MB(MAX_FILE_BYTES)} per file.`);
      continue;
    }
    if (total + file.size > MAX_MESSAGE_BYTES) {
      errors.push(`${name} did not go in. A message takes ${MB(MAX_MESSAGE_BYTES)} of files at most.`);
      continue;
    }
    try {
      const body = { name, data: await base64(file) };
      const saved = to.kind === 'cos' ? await api.cosAttach(body) : await api.attach(to.taskId, body);
      added.push(saved);
      count++;
      total += saved.bytes;
    } catch (err) {
      errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { added, errors };
}
