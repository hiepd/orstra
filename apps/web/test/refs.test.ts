import { describe, expect, it } from 'vitest';
import { findRefs, refTab } from '../src/lib/refs';

describe('findRefs', () => {
  it('finds a web link without the punctuation after it', () => {
    expect(findRefs('See (https://linear.app/acme/issue/HUB-402).')).toEqual([
      { kind: 'link', target: 'https://linear.app/acme/issue/HUB-402', label: 'linear.app/acme/issue/HUB-402' },
    ]);
  });

  it('knows a Claude artifact and a local dev server', () => {
    expect(findRefs('Review: https://claude.ai/artifact/5YZDMJUX')[0]).toMatchObject({ kind: 'artifact', target: 'https://claude.ai/artifact/5YZDMJUX' });
    expect(findRefs('Running at http://localhost:5401/search')[0]).toMatchObject({ kind: 'browser', label: 'localhost:5401/search' });
  });

  it('finds markdown and image paths, in code or plain', () => {
    expect(findRefs('I wrote `docs/specs/saved-searches.md` and .orstra/artifacts/spec/empty-state.png today')).toEqual([
      { kind: 'md', target: 'docs/specs/saved-searches.md', label: 'saved-searches.md' },
      { kind: 'image', target: '.orstra/artifacts/spec/empty-state.png', label: 'empty-state.png' },
    ]);
  });

  it('finds a path inside a fenced block too', () => {
    expect(findRefs('```\ncat docs/a.md\n```').map((r) => r.target)).toEqual(['docs/a.md']);
  });

  it('shows each reference once', () => {
    expect(findRefs('https://a.example/x and again https://a.example/x, and docs/a.md, docs/a.md')).toHaveLength(2);
  });

  it('leaves out absolute paths, and paths that are part of a URL', () => {
    expect(findRefs('/etc/x.md and https://github.com/o/r/blob/main/README.md').map((r) => r.kind)).toEqual(['link']);
    expect(findRefs('./docs/a.md')[0].target).toBe('docs/a.md');
  });
});

describe('refTab', () => {
  it('opens links as link tabs and files as file tabs', () => {
    expect(refTab({ kind: 'artifact', target: 'https://claude.ai/artifact/x', label: '' })).toBe('link:https://claude.ai/artifact/x');
    expect(refTab({ kind: 'md', target: 'docs/a.md', label: '' })).toBe('file:docs/a.md');
  });
});
