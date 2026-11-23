import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Markdown } from '../src/components/Markdown';

/** The markup one message body renders to. */
const html = (text: string) => renderToStaticMarkup(createElement(Markdown, { text }));

describe('Markdown', () => {
  it('renders the marks an agent writes inline', () => {
    const out = html('**bold** and *italic* and `inline code` and ~~gone~~');
    expect(out).toContain('<strong>bold</strong>');
    expect(out).toContain('<em>italic</em>');
    expect(out).toContain('<code>inline code</code>');
    expect(out).toContain('<del>gone</del>');
  });

  it('renders a heading, a list, a numbered list and a block quote', () => {
    const out = html('## What I found\n\n- one\n- two\n\n1. first\n2. second\n\n> a quote\n');
    expect(out).toContain('<h2>What I found</h2>');
    expect(out).toContain('<ul>');
    expect(out).toContain('<li>one</li>');
    expect(out).toContain('<ol>');
    expect(out).toContain('<li>first</li>');
    expect(out).toContain('<blockquote>');
  });

  it('opens a link in a new tab and hands it no reference back', () => {
    const out = html('see [the docs](https://example.com/a)');
    expect(out).toContain('href="https://example.com/a"');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer"');
  });

  it('names the language of a fenced block and keeps the code literal', () => {
    const out = html('```ts\nconst a = 1 < 2;\n```');
    expect(out).toContain('ox-mdcode');
    expect(out).toContain('<span class="ox-mdlang">ts</span>');
    expect(out).toContain('class="language-ts"');
    expect(out).toContain('const a = 1 &lt; 2;');
  });

  it('renders a table and wraps it so a wide one scrolls inside the message', () => {
    const out = html('| Step | State |\n| --- | --- |\n| build | ok |\n| test | failed |');
    expect(out).toContain('<div class="ox-mdtable"><table>');
    expect(out).toContain('<th>Step</th>');
    expect(out).toContain('<td>build</td>');
    expect(out).toContain('<td>failed</td>');
  });

  it('keeps one newline as a line break, as the chat did before', () => {
    expect(html('Did: a change\nLeft: nothing')).toContain('<br/>');
  });

  it('shows the HTML of a message as text, never as elements', () => {
    const out = html('<script>alert(1)</script>\n\n<b>shout</b>\n\n<img src="x" onerror="alert(2)">');
    expect(out).not.toContain('<script');
    expect(out).not.toContain('<b>');
    expect(out).not.toContain('<img');
    expect(out).not.toContain('onerror="');
    expect(out).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(out).toContain('&lt;b&gt;shout&lt;/b&gt;');
  });

  it('drops the href of a script link', () => {
    const out = html('[tap](javascript:alert(1))');
    expect(out).not.toContain('javascript:');
  });
});
