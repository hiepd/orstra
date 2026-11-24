import { beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listFiles, mimeOf, readWorktreeFile } from '../src/files.ts';

let dir: string;
const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'orstra-files-'));
  git('init', '-q');
  mkdirSync(join(dir, 'docs'));
  mkdirSync(join(dir, 'img'));
  mkdirSync(join(dir, 'node_modules'));
  writeFileSync(join(dir, 'docs/a.md'), '# A\n');
  writeFileSync(join(dir, '.gitignore'), 'node_modules\n');
  writeFileSync(join(dir, 'node_modules/x.js'), 'x');
  git('add', '.');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'a');
  writeFileSync(join(dir, 'img/b.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  symlinkSync('/etc/hosts', join(dir, 'docs/link'));
  writeFileSync(join(dir, '..', 'orstra-outside.txt'), 'secret');
});

describe('listFiles', () => {
  it('lists tracked and untracked files, without ignored ones, sorted', () => {
    const { paths, truncated } = listFiles(dir);
    expect(paths.filter((p) => p !== 'docs/link')).toEqual(['.gitignore', 'docs/a.md', 'img/b.png']);
    expect(truncated).toBe(false);
  });
});

describe('readWorktreeFile', () => {
  it('reads a file in the worktree, with its type', () => {
    const hit = readWorktreeFile(dir, 'docs/a.md');
    expect(hit?.body.toString()).toBe('# A\n');
    expect(hit?.mime).toBe('text/markdown; charset=utf-8');
    expect(hit?.name).toBe('a.md');
    expect(readWorktreeFile(dir, './img/b.png')?.mime).toBe('image/png');
  });

  it('refuses paths out of the worktree, also through a symlink', () => {
    expect(readWorktreeFile(dir, '../orstra-outside.txt')).toBeNull();
    expect(readWorktreeFile(dir, '/etc/hosts')).toBeNull();
    expect(readWorktreeFile(dir, 'docs/link')).toBeNull();
  });

  it('gives null for a missing file or a folder', () => {
    expect(readWorktreeFile(dir, 'docs/nope.md')).toBeNull();
    expect(readWorktreeFile(dir, 'docs')).toBeNull();
  });
});

describe('mimeOf', () => {
  it('never lets an HTML file render', () => {
    expect(mimeOf('x.html')).toBe('text/plain; charset=utf-8');
    expect(mimeOf('x.bin')).toBe('application/octet-stream');
    expect(mimeOf('x.SVG')).toBe('image/svg+xml');
  });
});
