import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseWorkflow } from '@orstra/core';
import { mergeTaskBranch } from '../src/merge.ts';
import { runAction } from '../src/actions.ts';

const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe', env }).toString();
const read = (dir: string, file: string) => sh(dir, 'show', `HEAD:${file}`);

/** A repository with one commit on `branch`, plus a task worktree off it. */
function repoWithTask(branch = 'main') {
  const repo = mkdtempSync(join(tmpdir(), 'orstra-merge-repo-'));
  sh(repo, 'init', '-q', '-b', branch);
  writeFileSync(join(repo, 'app.ts'), 'export const a = 1;\n');
  sh(repo, 'add', '.');
  sh(repo, 'commit', '-q', '-m', 'base');
  const wt = join(mkdtempSync(join(tmpdir(), 'orstra-merge-wt-')), 't1');
  sh(repo, 'worktree', 'add', '-q', wt, '-b', 'orstra/t1');
  return { repo, wt };
}

describe('mergeTaskBranch', () => {
  it('merges the task branch into the branch the repository has checked out', () => {
    const { repo, wt } = repoWithTask();
    writeFileSync(join(wt, 'app.ts'), 'export const a = 2;\n');
    sh(wt, 'commit', '-q', '-am', 'change a');

    const res = mergeTaskBranch(wt);
    expect(res.outcome).toBe('merged');
    expect(res.target).toBe('main');
    expect(res.branch).toBe('orstra/t1');
    expect(read(repo, 'app.ts')).toBe('export const a = 2;\n');
    expect(res.text).toContain('Nothing was pushed');
  });

  it('reads the target branch name instead of assuming "main"', () => {
    const { repo, wt } = repoWithTask('trunk');
    writeFileSync(join(wt, 'app.ts'), 'export const a = 3;\n');
    sh(wt, 'commit', '-q', '-am', 'change a');

    const res = mergeTaskBranch(wt);
    expect(res.outcome).toBe('merged');
    expect(res.target).toBe('trunk');
    expect(sh(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('trunk');
    expect(read(repo, 'app.ts')).toBe('export const a = 3;\n');
  });

  it('keeps commits made on the target branch while the task worked', () => {
    const { repo, wt } = repoWithTask();
    writeFileSync(join(wt, 'task.ts'), 'export const t = 1;\n');
    sh(wt, 'add', '.');
    sh(wt, 'commit', '-q', '-m', 'task work');
    writeFileSync(join(repo, 'other.ts'), 'export const o = 1;\n');
    sh(repo, 'add', '.');
    sh(repo, 'commit', '-q', '-m', 'other work');

    expect(mergeTaskBranch(wt).outcome).toBe('merged');
    expect(read(repo, 'task.ts')).toBe('export const t = 1;\n');
    expect(read(repo, 'other.ts')).toBe('export const o = 1;\n');
  });

  it('undoes a conflicted merge and leaves the repository as it was', () => {
    const { repo, wt } = repoWithTask();
    writeFileSync(join(wt, 'app.ts'), 'export const a = 2;\n');
    sh(wt, 'commit', '-q', '-am', 'task side');
    writeFileSync(join(repo, 'app.ts'), 'export const a = 99;\n');
    sh(repo, 'commit', '-q', '-am', 'main side');
    const before = sh(repo, 'rev-parse', 'HEAD');

    const res = mergeTaskBranch(wt);
    expect(res.outcome).toBe('conflict');
    expect(res.text).toContain('app.ts');
    expect(sh(repo, 'rev-parse', 'HEAD')).toBe(before);
    expect(sh(repo, 'status', '--porcelain')).toBe('');
    expect(read(repo, 'app.ts')).toBe('export const a = 99;\n');
  });

  it('refuses to merge when the main checkout has uncommitted changes', () => {
    const { repo, wt } = repoWithTask();
    writeFileSync(join(wt, 'task.ts'), 'export const t = 1;\n');
    sh(wt, 'add', '.');
    sh(wt, 'commit', '-q', '-m', 'task work');
    writeFileSync(join(repo, 'app.ts'), 'export const a = 1; // mine\n');
    const before = sh(repo, 'rev-parse', 'HEAD');

    const res = mergeTaskBranch(wt);
    expect(res.outcome).toBe('error');
    expect(res.text).toContain('uncommitted');
    expect(sh(repo, 'rev-parse', 'HEAD')).toBe(before);
    expect(sh(repo, 'status', '--porcelain')).toContain('app.ts');
  });

  it('does nothing when the task branch has no new commit', () => {
    const { repo, wt } = repoWithTask();
    writeFileSync(join(wt, 'draft.ts'), 'export const d = 1;\n'); // never committed
    const before = sh(repo, 'rev-parse', 'HEAD');

    const res = mergeTaskBranch(wt);
    expect(res.outcome).toBe('nothing');
    expect(res.text).toContain('no commits that main does not have');
    expect(sh(repo, 'rev-parse', 'HEAD')).toBe(before);
  });

  it('does nothing for a scratch repository with no main checkout', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orstra-merge-scratch-'));
    sh(dir, 'init', '-q', '-b', 'main');
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    sh(dir, 'add', '.');
    sh(dir, 'commit', '-q', '-m', 'first');
    expect(mergeTaskBranch(dir)).toMatchObject({ outcome: 'nothing', text: expect.stringContaining('scratch repository') });
  });

  it('does nothing when the worktree is empty, missing or not a repository', () => {
    const empty = mkdtempSync(join(tmpdir(), 'orstra-merge-empty-'));
    sh(empty, 'init', '-q', '-b', 'main');
    expect(mergeTaskBranch(empty)).toMatchObject({ outcome: 'nothing', text: expect.stringContaining('no commits') });
    expect(mergeTaskBranch(join(empty, 'gone'))).toMatchObject({ outcome: 'nothing' });
    expect(mergeTaskBranch(mkdtempSync(join(tmpdir(), 'orstra-merge-plain-')))).toMatchObject({ outcome: 'nothing' });
  });

  it('stops when the task worktree is not on a branch', () => {
    const { repo, wt } = repoWithTask();
    writeFileSync(join(wt, 'app.ts'), 'export const a = 2;\n');
    sh(wt, 'commit', '-q', '-am', 'change a');
    sh(wt, 'checkout', '-q', '--detach');
    const before = sh(repo, 'rev-parse', 'HEAD');

    expect(mergeTaskBranch(wt)).toMatchObject({ outcome: 'error', text: expect.stringContaining('detached HEAD') });
    expect(sh(repo, 'rev-parse', 'HEAD')).toBe(before);
  });

  it('never pushes: the merge leaves the remote behind', () => {
    const origin = mkdtempSync(join(tmpdir(), 'orstra-merge-origin-'));
    sh(origin, 'init', '-q', '--bare', '-b', 'main');
    const { repo, wt } = repoWithTask();
    sh(repo, 'remote', 'add', 'origin', origin);
    sh(repo, 'push', '-q', 'origin', 'main');
    writeFileSync(join(wt, 'app.ts'), 'export const a = 2;\n');
    sh(wt, 'commit', '-q', '-am', 'change a');
    const remoteBefore = sh(origin, 'rev-parse', 'main');

    expect(mergeTaskBranch(wt).outcome).toBe('merged');
    expect(sh(origin, 'rev-parse', 'main')).toBe(remoteBefore);
    expect(sh(origin, 'branch', '--list', 'orstra/t1')).toBe('');
  });
});

describe('the Simple workflow Orstra ships', () => {
  it('runs the merge as soon as you approve, then asks you to close it', () => {
    const path = fileURLToPath(new URL('../../../workflows/simple.yaml', import.meta.url));
    const wf = parseWorkflow(readFileSync(path, 'utf8'));
    expect(wf.steps.review.on.approved.goto).toBe('merge');
    expect(wf.steps.review.on.changes_requested.goto).toBe('work');
    expect(wf.steps.merge.use).toBe('action');
    expect(wf.steps.merge.action).toBe('git.merge');
    expect(wf.steps.merge.on).toEqual({ ok: { goto: 'done' } });
    expect(wf.steps.done.on.close.goto).toBe('end');
    expect(wf.steps.done.on.reopen.goto).toBe('work');
  });
});

describe('runAction', () => {
  it('maps the merge outcomes onto step outcomes', () => {
    const { wt } = repoWithTask();
    expect(runAction('git.merge', { cwd: wt, input: {} }).outcome).toBe('ok'); // nothing to merge
    writeFileSync(join(wt, 'app.ts'), 'export const a = 2;\n');
    sh(wt, 'commit', '-q', '-am', 'change a');
    expect(runAction('git.merge', { cwd: wt, input: {} }).outcome).toBe('ok'); // merged
  });

  it('passes an action it does not have, so the workflow still moves', () => {
    const res = runAction('linear.comment', { cwd: tmpdir(), input: {} });
    expect(res.outcome).toBe('ok');
    expect(res.text).toContain("isn't built yet");
  });
});
