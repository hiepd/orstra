import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ArtifactSpec } from '@orstra/core';
import { collectArtifacts, globToRegExp, kindOf, matchArtifacts, mimeOf, MAX_FILE_BYTES, seenKey } from '../src/artifacts.ts';

const spec = (path: string, required = false): ArtifactSpec => ({ name: path, path, required });

function worktree(files: Record<string, string | number>): string {
  const dir = mkdtempSync(join(tmpdir(), 'orstra-art-'));
  for (const [path, body] of Object.entries(files)) {
    const abs = join(dir, path);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, typeof body === 'number' ? Buffer.alloc(body) : body);
  }
  return dir;
}

describe('globToRegExp', () => {
  it('keeps * inside one folder', () => {
    const re = globToRegExp('out/*.png');
    expect(re.test('out/a.png')).toBe(true);
    expect(re.test('out/deep/a.png')).toBe(false);
    expect(re.test('out/a.txt')).toBe(false);
  });

  it('lets ** cross folders, including none', () => {
    const re = globToRegExp('coverage/**/*.html');
    expect(re.test('coverage/index.html')).toBe(true);
    expect(re.test('coverage/src/lib/a.html')).toBe(true);
    expect(re.test('other/index.html')).toBe(false);
  });

  it('treats dots as text, not as any character', () => {
    expect(globToRegExp('a.png').test('axpng')).toBe(false);
  });
});

describe('matchArtifacts', () => {
  it('finds the files a spec asks for and names the specs that matched nothing', () => {
    const dir = worktree({ 'out/a.png': 'x', 'out/b.png': 'y', 'src/app.ts': 'z' });
    const res = matchArtifacts(dir, [spec('out/*.png'), spec('coverage/*.html', true)]);
    expect(res.matches.map((m) => m.from).sort()).toEqual(['out/a.png', 'out/b.png']);
    expect(res.missing.map((m) => m.path)).toEqual(['coverage/*.html']);
  });

  it('leaves out a file an earlier run wrote', () => {
    const dir = worktree({ 'out/old.png': 'x', 'out/new.png': 'y' });
    const old = new Date(Date.now() - 60 * 60_000);
    utimesSync(join(dir, 'out/old.png'), old, old);
    const res = matchArtifacts(dir, [spec('out/*.png')], Date.now() - 60_000);
    expect(res.matches.map((m) => m.from)).toEqual(['out/new.png']);
  });

  it('never walks into .git or node_modules', () => {
    const dir = worktree({ '.git/x.png': 'x', 'node_modules/p/y.png': 'y', 'z.png': 'z' });
    const res = matchArtifacts(dir, [spec('**/*.png')]);
    expect(res.matches.map((m) => m.from)).toEqual(['z.png']);
  });
});

describe('collectArtifacts', () => {
  it('copies the file out of the worktree and hashes it', () => {
    const dir = worktree({ 'out/shot.png': 'bytes' });
    const root = mkdtempSync(join(tmpdir(), 'orstra-store-'));
    const res = collectArtifacts({ worktree: dir, specs: [spec('out/*.png')], taskId: 't1', runId: 'r1', root });
    expect(res.missing).toEqual([]);
    expect(res.saved).toHaveLength(1);
    const [a] = res.saved;
    expect(a.name).toBe('shot.png');
    expect(a.mime).toBe('image/png');
    expect(a.path).toBe(join(root, 't1', 'r1', 'shot.png'));
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keeps both files when 2 folders hold the same name', () => {
    const dir = worktree({ 'a/shot.png': '1', 'b/shot.png': '2' });
    const root = mkdtempSync(join(tmpdir(), 'orstra-store-'));
    const res = collectArtifacts({ worktree: dir, specs: [spec('**/*.png')], taskId: 't1', runId: 'r1', root });
    expect(res.saved.map((s) => s.name).sort()).toEqual(['shot-2.png', 'shot.png']);
  });

  it('records the gap instead of the bytes when a file is over the cap', () => {
    const dir = worktree({ 'out/trace.zip': MAX_FILE_BYTES + 1 });
    const root = mkdtempSync(join(tmpdir(), 'orstra-store-'));
    const res = collectArtifacts({ worktree: dir, specs: [spec('out/*.zip')], taskId: 't1', runId: 'r1', root });
    expect(res.saved[0].path).toBeNull();
    expect(res.saved[0].skipped).toMatch(/10 MB cap per file/);
  });
});

describe('mimeOf and kindOf', () => {
  it('names the types the review renders itself', () => {
    expect(kindOf(mimeOf('a.png'))).toBe('image');
    expect(kindOf(mimeOf('a.txt'))).toBe('text');
    expect(kindOf(mimeOf('a.json'))).toBe('text');
    expect(kindOf(mimeOf('a.zip'))).toBe('file');
    expect(mimeOf('a.unknown')).toBe('application/octet-stream');
  });
});

describe('stageInputs', () => {
  it('puts each stored copy under .orstra/inputs/<step>/ and rebuilds the folder every time', async () => {
    const { stageInputs } = await import('../src/artifacts.ts');
    const { existsSync, readFileSync } = await import('node:fs');
    const store = worktree({ 'r1/plan.md': 'plan v1' });
    const wt = worktree({ '.orstra/inputs/old/stale.txt': 'old' });
    const placed = stageInputs(wt, [{ stepId: 'plan', name: 'plan.md', from: join(store, 'r1/plan.md') }]);
    expect(placed).toEqual(['.orstra/inputs/plan/plan.md']);
    expect(readFileSync(join(wt, '.orstra/inputs/plan/plan.md'), 'utf8')).toBe('plan v1');
    expect(existsSync(join(wt, '.orstra/inputs/old/stale.txt'))).toBe(false);
  });
});

describe('collectArtifacts and what the task already keeps', () => {
  it('does not keep a file twice when it is still in the folder unchanged', () => {
    const dir = worktree({ '.orstra/artifacts/plan.md': 'same' });
    const root = mkdtempSync(join(tmpdir(), 'orstra-store-'));
    const first = collectArtifacts({ worktree: dir, specs: [spec('.orstra/artifacts/**/*')], taskId: 't', runId: 'r1', root });
    const again = collectArtifacts({ worktree: dir, specs: [spec('.orstra/artifacts/**/*')], taskId: 't', runId: 'r2', root, seen: new Set([seenKey('plan.md', first.saved[0].sha256!)]) });
    expect(first.saved).toHaveLength(1);
    expect(again.saved).toEqual([]);
    expect(again.missing).toEqual([]);
  });
});

describe('collectArtifacts with the same bytes under 2 names', () => {
  it('keeps a different file that happens to hold the same bytes', () => {
    const dir = worktree({ '.orstra/artifacts/report.txt': 'same', '.orstra/artifacts/seen.txt': 'same' });
    const root = mkdtempSync(join(tmpdir(), 'orstra-store-'));
    const sha = collectArtifacts({ worktree: worktree({ 'report.txt': 'same' }), specs: [spec('*.txt')], taskId: 't', runId: 'r0', root }).saved[0].sha256!;
    const res = collectArtifacts({ worktree: dir, specs: [spec('.orstra/artifacts/**/*')], taskId: 't', runId: 'r1', root, seen: new Set([seenKey('report.txt', sha)]) });
    expect(res.saved.map((s) => s.name)).toEqual(['seen.txt']);
  });
});
