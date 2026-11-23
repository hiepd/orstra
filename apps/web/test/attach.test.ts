import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_FILE_BYTES, MAX_FILES, MAX_MESSAGE_BYTES, humanBytes, upload } from '../src/lib/attach';
import type { ChatFile } from '../src/api';

const attach = vi.hoisted(() => vi.fn());
vi.mock('../src/api', () => ({
  api: { attach },
  ApiError: class extends Error {},
}));

const file = (name: string, size: number, type = 'image/png') => new File([new Uint8Array(size)], name, { type });
const saved = (name: string, bytes: number): ChatFile => ({ name, path: `.orstra/attachments/x/${name}`, bytes, mime: 'image/png' });

describe('files on a chat message', () => {
  beforeEach(() => {
    attach.mockReset();
    attach.mockImplementation((_t: string, b: { name: string; data: string }) => Promise.resolve(saved(b.name, Math.ceil((b.data.length * 3) / 4))));
  });

  it('sends the bytes and gives back what went in', async () => {
    const res = await upload('t-1', [file('image.png', 120)], []);
    expect(res.errors).toEqual([]);
    expect(res.added.map((f) => f.name)).toEqual(['image.png']);
    expect(attach).toHaveBeenCalledTimes(1);
    expect(attach.mock.calls[0][1].data).toMatch(/^[A-Za-z0-9+/=]+$/);
  });

  it('names a file over the cap and never sends it', async () => {
    const res = await upload('t-1', [file('huge.png', MAX_FILE_BYTES + 1), file('ok.png', 10)], []);
    expect(res.errors).toEqual(['huge.png is 10.0 MB. The cap is 10 MB per file.']);
    expect(res.added.map((f) => f.name)).toEqual(['ok.png']);
    expect(attach).toHaveBeenCalledTimes(1);
  });

  it('names an empty file', async () => {
    const res = await upload('t-1', [file('empty.png', 0)], []);
    expect(res.errors).toEqual(['empty.png is empty.']);
    expect(attach).not.toHaveBeenCalled();
  });

  it('counts the files already on the draft', async () => {
    const already = Array.from({ length: MAX_FILES }, (_, i) => saved(`a${i}.png`, 10));
    const res = await upload('t-1', [file('one-too-many.png', 10)], already);
    expect(res.added).toEqual([]);
    expect(res.errors[0]).toContain('5 files at most');
  });

  it('keeps the whole message under its cap', async () => {
    const already = [saved('big.png', MAX_MESSAGE_BYTES - 100)];
    const res = await upload('t-1', [file('next.png', 500)], already);
    expect(res.added).toEqual([]);
    expect(res.errors[0]).toContain('25 MB of files at most');
  });

  it('keeps the other files when one upload fails', async () => {
    attach.mockRejectedValueOnce(new Error('This task has no worktree yet, so a file has nowhere to go.'));
    const res = await upload('t-1', [file('a.png', 10), file('b.png', 10)], []);
    expect(res.errors).toEqual(['a.png: This task has no worktree yet, so a file has nowhere to go.']);
    expect(res.added.map((f) => f.name)).toEqual(['b.png']);
  });

  it('shows sizes the way the daemon does', () => {
    expect(humanBytes(900)).toBe('900 B');
    expect(humanBytes(188_416)).toBe('184 KB');
    expect(humanBytes(2_621_440)).toBe('2.5 MB');
  });
});
