import { useEffect, useState, type ReactNode } from 'react';
import { documentToken, mermaidConfig } from '../lib/mermaidTheme';
import { getThemeChoice, resolveTheme, subscribeTheme } from '../lib/theme';

let seq = 0;

/** The first line of what mermaid threw, which names the line and the token it tripped on. */
function reason(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.split('\n')[0].trim().slice(0, 160);
}

/**
 * One mermaid diagram in a message.
 *
 * `children` is the code block the chat shows for any other fence. It stands in until the drawing
 * arrives, and it stays when mermaid cannot parse the diagram, so a message never loses what the
 * agent wrote. Mermaid is loaded the first time a diagram shows: it is far bigger than the rest of
 * the UI, and most messages have no diagram.
 *
 * Mermaid hands a drawing over as a string of SVG, which is why it goes in through
 * `dangerouslySetInnerHTML`. The text is untrusted, so the config keeps `securityLevel: 'strict'`
 * and no HTML labels: a label is text, never markup (`lib/mermaidTheme.ts`).
 */
export function Mermaid({ code, children }: { code: string; children: ReactNode }) {
  const [svg, setSvg] = useState('');
  const [failure, setFailure] = useState('');
  const [theme, setTheme] = useState(() => resolveTheme(getThemeChoice()));

  useEffect(() => subscribeTheme(() => setTheme(resolveTheme(getThemeChoice()))), []);

  useEffect(() => {
    let live = true;
    const id = `ox-mermaid-${(seq += 1)}`;
    void (async () => {
      try {
        const { default: mermaid } = await import('mermaid');
        mermaid.initialize(mermaidConfig(theme, documentToken()));
        const drawn = await mermaid.render(id, code);
        if (!live) return;
        setSvg(drawn.svg);
        setFailure('');
      } catch (err) {
        if (!live) return;
        setSvg('');
        setFailure(reason(err));
      }
    })();
    return () => {
      live = false;
    };
  }, [code, theme]);

  if (svg)
    return (
      <figure
        className="ox-mermaid"
        data-state="drawn"
        role="img"
        aria-label="Diagram"
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    );

  return (
    <div className="ox-mermaid" data-state={failure ? 'failed' : 'source'}>
      {failure && <p className="ox-mermaid-err">This diagram could not be drawn. {failure}</p>}
      {children}
    </div>
  );
}
