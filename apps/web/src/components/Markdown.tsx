import { memo } from 'react';
import ReactMarkdown, { type Components, type ExtraProps } from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';

// GFM adds the GitHub table, strikethrough and task-list syntax. Breaks keeps one newline as a
// line break, the way the chat read before it rendered markdown.
const PLUGINS = [remarkGfm, remarkBreaks];
const LANG = 'language-';

/** The language of a fenced block: react-markdown writes it on the `<code>` as `language-ts`. */
function langOf(node: ExtraProps['node']): string {
  const code = node?.children.find((c) => c.type === 'element');
  const names = code?.type === 'element' ? [code.properties.className].flat() : [];
  const hit = names.find((c) => typeof c === 'string' && c.startsWith(LANG));
  return typeof hit === 'string' ? hit.slice(LANG.length) : '';
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
  // A fenced block: its language above it, the code itself scrolling sideways.
  pre: ({ children, node, ...props }) => {
    const lang = langOf(node);
    return (
      <div className="ox-mdcode">
        {lang && <span className="ox-mdlang">{lang}</span>}
        <pre {...props}>{children}</pre>
      </div>
    );
  },
};

/**
 * One message body as markdown: bold, italic, lists, headings, links, code and GitHub tables.
 *
 * The text is untrusted. react-markdown builds React elements, so nothing goes through
 * innerHTML, and without rehype-raw it drops any HTML the message carries. Keep it that way.
 */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="ox-md">
      <ReactMarkdown remarkPlugins={PLUGINS} components={COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
