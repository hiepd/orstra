import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { gitDiff, gitInfo } from '../src/git.ts';

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });

describe('gitInfo', () => {
  it('returns null outside a repository', () => {
    expect(gitInfo(mkdtempSync(join(tmpdir(), 'orstra-nogit-')))).toBeNull();
  });

  it('treats a scratch repository as all the task’s work', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orstra-scratch-'));
    sh(dir, 'init', '-q', '-b', 'main');
    writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n');
    let info = gitInfo(dir)!;
    expect(info.branch).toBe('main');
    expect(info.base).toBeNull();
    expect(info.files).toEqual([{ path: 'a.txt', status: 'A', add: 2, del: 0, uncommitted: true }]);
    expect(info.commits).toEqual([]);

    sh(dir, 'add', '.');
    sh(dir, 'commit', '-q', '-m', 'first');
    writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree\n');
    info = gitInfo(dir)!;
    expect(info.ahead).toBe(1);
    expect(info.commits.map((c) => c.message)).toEqual(['first']);
    expect(info.files).toEqual([{ path: 'a.txt', status: 'A', add: 3, del: 0, uncommitted: true }]);
    expect(gitDiff(dir, 'a.txt')!.diff).toContain('+three');
  });

  it('compares a worktree with the commit it branched from', () => {
    const repo = mkdtempSync(join(tmpdir(), 'orstra-repo-'));
    sh(repo, 'init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'app.ts'), 'export const a = 1;\n');
    sh(repo, 'add', '.');
    sh(repo, 'commit', '-q', '-m', 'base');
    const wt = join(mkdtempSync(join(tmpdir(), 'orstra-wt-')), 't1');
    sh(repo, 'worktree', 'add', '-q', wt, '-b', 'orstra/t1');

    writeFileSync(join(wt, 'app.ts'), 'export const a = 2;\n');
    sh(wt, 'commit', '-q', '-am', 'change a');
    writeFileSync(join(wt, 'new.ts'), 'export const b = 1;\n');

    const info = gitInfo(wt)!;
    expect(info.branch).toBe('orstra/t1');
    expect(info.base).toBe('main');
    expect(info.ahead).toBe(1);
    expect(info.uncommitted).toBe(1);
    expect(info.files).toEqual([
      { path: 'app.ts', status: 'M', add: 1, del: 1, uncommitted: false },
      { path: 'new.ts', status: 'A', add: 1, del: 0, uncommitted: true },
    ]);
    expect(info.commits.map((c) => c.message)).toEqual(['change a']);
    expect(gitDiff(wt, 'app.ts')!.diff).toContain('-export const a = 1;');
    expect(gitDiff(wt, 'new.ts')!.diff).toContain('+export const b = 1;');
    expect(gitDiff(wt, '../outside')).toBeNull();
  });
});
