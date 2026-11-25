import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findRepos, listFolders, pickFolder, type RunPicker } from '../src/folders.ts';

/** A folder tree. A name that ends in "/.git" makes its parent a repo; ".git=file" makes a worktree's .git file. */
function tree(paths: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'orstra-folders-'));
  for (const p of paths) {
    if (p.endsWith('.git=file')) {
      const dir = join(root, p.slice(0, -'/.git=file'.length));
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, '.git'), 'gitdir: elsewhere\n');
    } else mkdirSync(join(root, p), { recursive: true });
  }
  return root;
}

describe('findRepos', () => {
  it('finds repos 1 and 2 levels under the usual code folders, never looks inside a repo, and skips worktrees', () => {
    const home = tree([
      'workspace/hub/.git',
      'workspace/hub/packages/inner/.git',
      'workspace/acme/api/.git',
      'workspace/acme/deep/er/than/two/.git',
      'code/tool/.git',
      'code/tool-feature/.git=file',
      'workspace/.hidden/.git',
      'workspace/node_modules/pkg/.git',
      'Documents/notes/.git',
    ]);
    expect(findRepos(home)).toEqual([join(home, 'code/tool'), join(home, 'workspace/acme/api'), join(home, 'workspace/hub')]);
  });

  it('gives nothing when no code folder exists', () => {
    expect(findRepos(tree(['Desktop']))).toEqual([]);
  });

  it('stops at the limit', () => {
    const home = tree(Array.from({ length: 5 }, (_, i) => `src/r${i}/.git`));
    expect(findRepos(home, { max: 3 })).toHaveLength(3);
  });
});

describe('listFolders', () => {
  it('lists the folders in a folder, marks the repos, and hides dot folders and files', () => {
    const root = tree(['a/.git', 'b', '.cache']);
    writeFileSync(join(root, 'file.txt'), 'x');
    expect(listFolders(root)).toEqual({
      path: root,
      parent: join(root, '..'),
      repo: false,
      folders: [
        { name: 'a', path: join(root, 'a'), repo: true },
        { name: 'b', path: join(root, 'b'), repo: false },
      ],
    });
  });

  it('says so when the folder does not exist', () => {
    expect(() => listFolders('/no/such/folder/here')).toThrow(/does not exist/);
  });

  it('has no parent at the root of the disk', () => {
    expect(listFolders('/').parent).toBeNull();
  });
});

describe('pickFolder', () => {
  const ok = (out: string): RunPicker => async () => ({ code: 0, stdout: out, stderr: '' });

  it('returns the folder you chose, without the trailing slash', async () => {
    expect(await pickFolder('darwin', ok('/Users/me/workspace/hub/\n'))).toEqual({ path: '/Users/me/workspace/hub' });
  });

  it('says canceled when you close the dialog', async () => {
    const cancel: RunPicker = async () => ({ code: 1, stdout: '', stderr: 'execution error: User canceled. (-128)' });
    expect(await pickFolder('darwin', cancel)).toEqual({ canceled: true });
    expect(await pickFolder('linux', async () => ({ code: 1, stdout: '', stderr: '' }))).toEqual({ canceled: true });
  });

  it('says unsupported when the system has no dialog, so the page shows its own list', async () => {
    expect(await pickFolder('win32', ok('C:\\x'))).toMatchObject({ unsupported: true });
    const missing: RunPicker = async () => ({ code: -1, stdout: '', stderr: 'spawn zenity ENOENT' });
    expect(await pickFolder('linux', missing)).toMatchObject({ unsupported: true });
    const noGui: RunPicker = async () => ({ code: 1, stdout: '', stderr: 'execution error: No user interaction allowed. (-1713)' });
    expect(await pickFolder('darwin', noGui)).toMatchObject({ unsupported: true });
  });

  it('opens no dialog when ORSTRA_FOLDER_DIALOG=off, for a daemon on a machine you do not sit at', async () => {
    let calls = 0;
    const r = await pickFolder('darwin', async () => (calls++, { code: 0, stdout: '/x', stderr: '' }), { ORSTRA_FOLDER_DIALOG: 'off' });
    expect(r).toMatchObject({ unsupported: true });
    expect(calls).toBe(0);
  });

  it('opens 1 dialog at a time: a second ask waits for the first', async () => {
    let calls = 0;
    let done: (v: { code: number; stdout: string; stderr: string }) => void = () => {};
    const slow: RunPicker = () => {
      calls++;
      return new Promise((r) => (done = r));
    };
    const a = pickFolder('darwin', slow);
    const b = pickFolder('darwin', slow);
    done({ code: 0, stdout: '/x/\n', stderr: '' });
    expect(await a).toEqual({ path: '/x' });
    expect(await b).toEqual({ path: '/x' });
    expect(calls).toBe(1);
  });
});
