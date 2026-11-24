import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACTION_NAMES } from '@orstra/core';
import { ACTIONS, prBody, runAction } from '../src/actions.ts';
import { cleanupWorktree } from '../src/cleanup.ts';
import { openPullRequest } from '../src/github.ts';

const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe', env }).toString().trim();

/** A repository with a bare remote, one commit on main, and a task worktree on orstra/t1. */
function repo() {
  const remote = mkdtempSync(join(tmpdir(), 'orstra-remote-'));
  sh(remote, 'init', '-q', '--bare', '-b', 'main');
  const main = mkdtempSync(join(tmpdir(), 'orstra-repo-'));
  sh(main, 'init', '-q', '-b', 'main');
  writeFileSync(join(main, 'a.txt'), 'a\n');
  sh(main, 'add', '.');
  sh(main, 'commit', '-q', '-m', 'base');
  sh(main, 'remote', 'add', 'origin', remote);
  const wt = join(mkdtempSync(join(tmpdir(), 'orstra-wt-')), 't1');
  sh(main, 'worktree', 'add', '-q', wt, '-b', 'orstra/t1');
  return { remote, main, wt };
}

function commit(wt: string, file = 'b.txt') {
  writeFileSync(join(wt, file), 'b\n');
  sh(wt, 'add', '.');
  sh(wt, 'commit', '-q', '-m', 'work');
}

/** A fake gh that logs its arguments and prints a pull request URL. */
function fakeGh(existing = '') {
  const dir = mkdtempSync(join(tmpdir(), 'orstra-gh-'));
  const log = join(dir, 'log');
  const bin = join(dir, 'gh');
  writeFileSync(bin, `#!/bin/sh\necho "$@" >> ${log}\nif [ "$2" = "view" ]; then printf '%s' '${existing}'; exit 0; fi\necho https://github.com/o/r/pull/7\n`);
  chmodSync(bin, 0o755);
  process.env.ORSTRA_GH_BIN = bin;
  return { log: () => (existsSync(log) ? readFileSync(log, 'utf8') : '') };
}

afterEach(() => {
  delete process.env.ORSTRA_GH_BIN;
});

describe('actions', () => {
  it('has exactly the actions the parser accepts', () => {
    expect(Object.keys(ACTIONS).sort()).toEqual([...ACTION_NAMES].sort());
  });

  it('writes a pull request body from the ticket, the ask and the progress', () => {
    const body = prBody({ cwd: '', input: {}, task: { title: 'x', ref: 'HUB-1', description: 'Fix it' }, progress: '- Work: did it' });
    expect(body).toContain('Ticket: HUB-1');
    expect(body).toContain('Fix it');
    expect(body).toContain('- Work: did it');
  });
});

describe('github.pr', () => {
  it('pushes the branch and opens a draft pull request', () => {
    const { remote, wt } = repo();
    commit(wt);
    const gh = fakeGh();
    const res = runAction('github.pr', { cwd: wt, input: {}, task: { title: 'Empty state', ref: 'HUB-416', description: '' } });
    expect(res.outcome).toBe('ok');
    expect(res.prUrl).toBe('https://github.com/o/r/pull/7');
    expect(gh.log()).toContain('--draft');
    expect(gh.log()).toContain('HUB-416 Empty state');
    expect(sh(remote, 'branch', '--list', 'orstra/t1')).toContain('orstra/t1');
  });

  it('returns the open pull request instead of a second one', () => {
    const { wt } = repo();
    commit(wt);
    const gh = fakeGh('https://github.com/o/r/pull/3');
    const res = openPullRequest(wt, { title: 't', body: 'b' });
    expect(res.outcome).toBe('exists');
    expect(res.url).toBe('https://github.com/o/r/pull/3');
    expect(gh.log()).not.toContain('create');
  });

  it('opens nothing when the branch has no new commit', () => {
    const { wt } = repo();
    fakeGh();
    expect(openPullRequest(wt, { title: 't', body: 'b' }).outcome).toBe('nothing');
  });

  it('refuses a scratch repository', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orstra-scratch-'));
    sh(dir, 'init', '-q', '-b', 'main');
    expect(openPullRequest(dir, { title: 't', body: 'b' }).outcome).toBe('error');
  });
});

describe('cleanupWorktree', () => {
  it('removes the worktree and a merged branch', () => {
    const { main, wt } = repo();
    commit(wt);
    sh(main, 'merge', '-q', '--no-edit', 'orstra/t1');
    const res = cleanupWorktree(wt);
    expect(res.outcome).toBe('removed');
    expect(existsSync(wt)).toBe(false);
    expect(sh(main, 'branch', '--list', 'orstra/t1')).toBe('');
  });

  it('keeps a branch that is not merged, so its commits stay', () => {
    const { main, wt } = repo();
    commit(wt);
    const res = cleanupWorktree(wt);
    expect(res.outcome).toBe('removed');
    expect(res.text).toContain('Kept the branch');
    expect(sh(main, 'branch', '--list', 'orstra/t1')).toContain('orstra/t1');
  });

  it('refuses uncommitted work unless forced', () => {
    const { wt } = repo();
    writeFileSync(join(wt, 'a.txt'), 'changed\n');
    expect(cleanupWorktree(wt).outcome).toBe('refused');
    expect(existsSync(wt)).toBe(true);
    expect(cleanupWorktree(wt, { force: true }).outcome).toBe('removed');
    expect(existsSync(wt)).toBe(false);
  });

  it('calls beforeRemove only when it really removes, after the checks that can refuse', () => {
    const { wt } = repo();
    writeFileSync(join(wt, 'a.txt'), 'changed\n');
    let calls = 0;
    expect(cleanupWorktree(wt, { beforeRemove: () => calls++ }).outcome).toBe('refused');
    expect(calls).toBe(0);
    expect(runAction('git.cleanup', { cwd: wt, input: { force: true }, beforeRemove: () => calls++ }).outcome).toBe('ok');
    expect(calls).toBe(1);
  });

  it('refuses a scratch repository with work unless forced', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orstra-scratch-'));
    sh(dir, 'init', '-q', '-b', 'main');
    commit(dir, 'x.txt');
    expect(cleanupWorktree(dir).outcome).toBe('refused');
    expect(cleanupWorktree(dir, { force: true }).outcome).toBe('removed');
    expect(existsSync(dir)).toBe(false);
  });
});
