import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ATTACH_DIR, MAX_FILE_BYTES, attachPath, checkAttachments, cosFiles, excludeFromGit, humanBytes, mimeOf,
  readAttachment, readRule, safeName, saveAttachment, taskFiles, withFiles,
} from '../src/attachments.ts';

/** A worktree-like folder with git in it, as a task gets from `createWorktree`. */
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'orstra-attach-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, stdio: 'pipe' });
  return { dir, files: taskFiles(dir) };
}

/** The chief of staff folder: Orstra's own, no git, no `.orstra` inside it. */
function cos() {
  const dir = mkdtempSync(join(tmpdir(), 'orstra-cos-'));
  return { dir, files: cosFiles(dir) };
}

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64');

describe('attachments', () => {
  it('writes the file into the worktree and gives back the path the agent reads', () => {
    const { dir, files } = repo();
    const a = saveAttachment(files, { name: 'image.png', data: PNG });
    expect(a.path.startsWith(`${ATTACH_DIR}/`)).toBe(true);
    expect(a.name).toBe('image.png');
    expect(a.mime).toBe('image/png');
    expect(a.bytes).toBe(16);
    expect(existsSync(join(dir, a.path))).toBe(true);
  });

  it('keeps 2 pastes of the same name apart', () => {
    const { dir, files } = repo();
    const a = saveAttachment(files, { name: 'image.png', data: PNG });
    const b = saveAttachment(files, { name: 'image.png', data: PNG });
    expect(a.path).not.toBe(b.path);
    expect(existsSync(join(dir, a.path))).toBe(true);
    expect(existsSync(join(dir, b.path))).toBe(true);
  });

  it('cleans the name, so no path can come in through it', () => {
    expect(safeName('../../etc/passwd')).toBe('passwd');
    expect(safeName('/tmp/a b c.log')).toBe('a-b-c.log');
    expect(safeName('..')).toBe('file');
    expect(safeName('')).toBe('file');
    expect(safeName('a'.repeat(200) + '.png').length).toBeLessThanOrEqual(80);
    expect(safeName('a'.repeat(200) + '.png').endsWith('.png')).toBe(true);
  });

  it('stores a file named like a path inside the attachments folder', () => {
    const { dir, files } = repo();
    const a = saveAttachment(files, { name: '../../../etc/passwd', data: PNG });
    expect(a.path).toBe(`${ATTACH_DIR}/${a.path.split('/')[2]}/passwd`);
    expect(existsSync(join(dir, a.path))).toBe(true);
  });

  it('says the size and the cap when a file is too big', () => {
    const { files } = repo();
    const big = Buffer.alloc(MAX_FILE_BYTES + 1).toString('base64');
    expect(() => saveAttachment(files, { name: 'huge.bin', data: big })).toThrow(/The cap is 10 MB per file/);
    expect(() => saveAttachment(files, { name: 'empty.txt', data: '' })).toThrow(/empty/);
  });

  it('never lets a path leave the attachments folder', () => {
    const { dir, files } = repo();
    saveAttachment(files, { name: 'image.png', data: PNG });
    expect(attachPath(files, `${ATTACH_DIR}/../../etc/passwd`)).toBeNull();
    expect(attachPath(files, '/etc/passwd')).toBeNull();
    expect(attachPath(files, '.orstra/artifacts/screen.png')).toBeNull();
    expect(attachPath(files, 'src/index.ts')).toBeNull();
    expect(attachPath(files, '')).toBeNull();
    expect(attachPath(files, `${ATTACH_DIR}/x/ok.png`)).toBe(join(dir, ATTACH_DIR, 'x', 'ok.png'));
  });

  it('refuses a symlink that points out of the folder', () => {
    const { dir, files } = repo();
    const secret = join(dir, 'secret.txt');
    writeFileSync(secret, 'tokens');
    mkdirSync(join(dir, ATTACH_DIR, 'sneak'), { recursive: true });
    symlinkSync(secret, join(dir, ATTACH_DIR, 'sneak', 'image.png'));
    expect(attachPath(files, `${ATTACH_DIR}/sneak/image.png`)).toBeNull();
    expect(readAttachment(files, `${ATTACH_DIR}/sneak/image.png`)).toBeNull();
  });

  it('reads the bytes back with the type that the name says', () => {
    const { files } = repo();
    const a = saveAttachment(files, { name: 'run.log', data: Buffer.from('boom').toString('base64') });
    const hit = readAttachment(files, a.path)!;
    expect(hit.body.toString()).toBe('boom');
    expect(hit.mime).toBe('text/plain');
    expect(readAttachment(files, `${ATTACH_DIR}/nope/x.png`)).toBeNull();
  });

  it('adds .orstra to the git exclude file once, and not to .gitignore', () => {
    const { dir, files } = repo();
    writeFileSync(join(dir, '.gitignore'), 'node_modules\n');
    const a = saveAttachment(files, { name: 'image.png', data: PNG });
    saveAttachment(files, { name: 'two.png', data: PNG });
    const exclude = readFileSync(join(dir, '.git/info/exclude'), 'utf8');
    expect(exclude.split('\n').filter((l) => l.trim() === '/.orstra/')).toHaveLength(1);
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('node_modules\n');
    const status = execFileSync('git', ['-C', dir, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' });
    expect(status).not.toContain('.orstra');
    expect(status).not.toContain(a.name);
  });

  it('writes the exclude line even when the repository has none yet', () => {
    const { dir } = repo();
    execFileSync('rm', ['-f', join(dir, '.git/info/exclude')]);
    excludeFromGit(dir);
    expect(readFileSync(join(dir, '.git/info/exclude'), 'utf8')).toContain('/.orstra/');
  });

  it('checks a message\'s files against the disk', () => {
    const { files } = repo();
    const a = saveAttachment(files, { name: 'image.png', data: PNG });
    expect(checkAttachments(files, [{ path: a.path, bytes: 1, name: 'lie.png' }])).toEqual([a]);
    expect(checkAttachments(files, [])).toEqual([]);
    expect(checkAttachments(files, undefined)).toEqual([]);
    expect(() => checkAttachments(files, [{ path: '../../etc/passwd' }])).toThrow(/no longer there/);
    expect(() => checkAttachments(files, [{ path: `${ATTACH_DIR}/gone/x.png` }])).toThrow(/no longer there/);
    expect(() => checkAttachments(files, new Array(6).fill({ path: a.path }))).toThrow(/The cap is 5/);
  });

  it('leaves your text alone when you attached nothing', () => {
    expect(withFiles('fix this', [])).toBe('fix this');
  });

  it('puts the paths after your text when you attached something', () => {
    const files = [{ name: 'image.png', path: `${ATTACH_DIR}/ab12/image.png`, bytes: 188_416, mime: 'image/png' }];
    const out = withFiles('fix this', files);
    expect(out.startsWith('fix this\n\n')).toBe(true);
    expect(out).toContain(`${ATTACH_DIR}/ab12/image.png`);
    expect(out).toContain('184 KB');
    expect(withFiles('', files).startsWith('I attached 1 file')).toBe(true);
  });

  it('names sizes and types the way the UI shows them', () => {
    expect(humanBytes(900)).toBe('900 B');
    expect(humanBytes(188_416)).toBe('184 KB');
    expect(humanBytes(2_621_440)).toBe('2.5 MB');
    expect(mimeOf('a.PNG')).toBe('image/png');
    expect(mimeOf('report.pdf')).toBe('application/pdf');
    expect(mimeOf('thing.unknown')).toBe('application/octet-stream');
  });
});

describe('the chief of staff folder', () => {
  it('keeps its files in its own folder, with no .orstra inside it and no git', () => {
    const { dir, files } = cos();
    const a = saveAttachment(files, { name: 'image.png', data: PNG });
    expect(a.path).toMatch(/^attachments\/[a-z0-9]+\/image\.png$/);
    expect(existsSync(join(dir, a.path))).toBe(true);
    expect(existsSync(join(dir, '.git'))).toBe(false);
    expect(existsSync(join(dir, '.orstra'))).toBe(false);
  });

  it('never lets a path leave that folder either', () => {
    const { files } = cos();
    saveAttachment(files, { name: 'image.png', data: PNG });
    expect(attachPath(files, '../../../etc/passwd')).toBeNull();
    expect(attachPath(files, '/etc/passwd')).toBeNull();
    expect(attachPath(files, 'mcp.json')).toBeNull();
    expect(attachPath(files, 'attachments/../../mcp.json')).toBeNull();
  });

  it('gives Claude Code a Read rule for that folder and nothing else', () => {
    const { dir, files } = cos();
    expect(readRule(files)).toBe(`Read(/${dir}/attachments/**)`);
    expect(readRule(files).startsWith('Read(//')).toBe(true);
  });
});
