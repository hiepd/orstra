import { memo, useMemo, type MouseEvent } from 'react';
import ReactMarkdown, { type Components, type ExtraProps } from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import { Mermaid } from './Mermaid';

// GFM adds the GitHub table, strikethrough and task-list syntax. Breaks keeps one newline as a
// line break, the way the chat read before it rendered markdown.
const PLUGINS = [remarkGfm, remarkBreaks];
const LANG = 'language-';

/** The `<code>` inside a `<pre>`: react-markdown puts the fence's text and language on it. */
function codeOf(node: ExtraProps['node']) {
  const code = node?.children.find((c) => c.type === 'element');
  return code?.type === 'element' ? code : null;
}

/** The language of a fenced block: react-markdown writes it on the `<code>` as `language-ts`. */
function langOf(node: ExtraProps['node']): string {
  const names = [codeOf(node)?.properties.className].flat();
  const hit = names.find((c) => typeof c === 'string' && c.startsWith(LANG));
  return typeof hit === 'string' ? hit.slice(LANG.length) : '';
}

/** The text of a fenced block, as the agent wrote it. */
function textOf(node: ExtraProps['node']): string {
  const code = codeOf(node);
  return code ? code.children.map((c) => (c.type === 'text' ? c.value : '')).join('') : '';
}

const COMPONENTS: Components = {
  // The text is untrusted, so a link opens away from the app and the new tab gets no handle on it.
  a: ({ children, node: _node, ...props }) => (
    <a {...props} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
  // A wide table scrolls inside the message instead of stretching the page.
  table: ({ children, node: _node, ...props }) => (
    <div className="ox-mdtable">
      <table {...props}>{children}</table>
    </div>
  ),
  // A fenced block: its language above it, the code itself scrolling sideways. A mermaid block is
  // drawn instead, and keeps this block as what it falls back to.
  pre: ({ children, node, ...props }) => {
    const lang = langOf(node);
    const block = (
      <div className="ox-mdcode">
        {lang && <span className="ox-mdlang">{lang}</span>}
        <pre {...props}>{children}</pre>
      </div>
    );
    if (lang !== 'mermaid') return block;
    return <Mermaid code={textOf(node)}>{block}</Mermaid>;
  },
};

/**
 * One message body as markdown: bold, italic, lists, headings, links, code and GitHub tables.
 *
 * The text is untrusted. react-markdown builds React elements, so nothing goes through
 * innerHTML, and without rehype-raw it drops any HTML the message carries. Keep it that way.
 */
export const Markdown = memo(function Markdown({ text, onLink }: { text: string; onLink?: (href: string) => void }) {
  // With onLink, a plain click on a link opens it in the side viewer. A ⌘-click, a Ctrl-click or a
  // middle click still opens a new browser tab.
  const components = useMemo<Components>(() => {
    if (!onLink) return COMPONENTS;
    return {
      ...COMPONENTS,
      a: ({ children, node: _node, ...props }) => (
        <a
          {...props}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e: MouseEvent<HTMLAnchorElement>) => {
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0 || !props.href || !/^https?:/i.test(props.href)) return;
            e.preventDefault();
            onLink(props.href);
          }}
        >
          {children}
        </a>
      ),
    };
  }, [onLink]);
  return (
    <div className="ox-md">
      <ReactMarkdown remarkPlugins={PLUGINS} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
