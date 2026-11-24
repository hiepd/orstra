import { describe, expect, it, vi } from 'vitest';
import { frameableFrom, linkInfo, titleFrom } from '../src/linkInfo.ts';

const h = (o: Record<string, string>) => new Headers(o);

describe('frameableFrom', () => {
  it('reads X-Frame-Options and CSP frame-ancestors', () => {
    expect(frameableFrom(h({ 'x-frame-options': 'DENY' }))).toBe(false);
    expect(frameableFrom(h({ 'x-frame-options': 'sameorigin' }))).toBe(false);
    expect(frameableFrom(h({ 'content-security-policy': "default-src 'self'; frame-ancestors 'none'" }))).toBe(false);
    expect(frameableFrom(h({ 'content-security-policy': "frame-ancestors 'self'" }))).toBe(false);
    expect(frameableFrom(h({ 'content-security-policy': 'frame-ancestors *' }))).toBe(true);
    expect(frameableFrom(h({}))).toBe(true);
  });
});

describe('titleFrom', () => {
  it('takes the title and decodes the common entities', () => {
    expect(titleFrom('<html><head><title> Saved &amp; searches </title>')).toBe('Saved & searches');
    expect(titleFrom('<p>no title</p>')).toBeNull();
  });
});

describe('linkInfo', () => {
  it('says not frameable, with no title, when the fetch fails', async () => {
    const f = vi.fn().mockRejectedValue(new Error('offline'));
    expect(await linkInfo('https://fails.example/a', f)).toEqual({ url: 'https://fails.example/a', frameable: false, title: null });
  });

  it('keeps an answer for 10 minutes', async () => {
    const f = vi.fn().mockResolvedValue(new Response('<title>T</title>', { headers: { 'x-frame-options': 'DENY', 'content-type': 'text/html' } }));
    await linkInfo('https://cache.example/', f);
    const second = await linkInfo('https://cache.example/', f);
    expect(f).toHaveBeenCalledTimes(1);
    expect(second).toEqual({ url: 'https://cache.example/', frameable: false, title: 'T' });
  });

  it('refuses anything but http and https', async () => {
    await expect(linkInfo('file:///etc/hosts')).rejects.toThrow(/http/);
  });
});
