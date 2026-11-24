# Mermaid diagrams in chat: design

Date: 2026-11-24. Size: a small change. Status: built on `orstra/chat-mermaid`.

## Why

Agents draw. Asked how a workflow routes, or how the daemon, the runner and a session
hand work to each other, an agent writes a mermaid block, because that is what it writes
in a markdown file. The chat shows the block as code, so you read the arrows as text.
`Markdown.tsx` already renders the rest of what an agent writes. The diagram is the one
thing it still shows as source.

## Goals

- A ```mermaid fenced block in a chat message renders as a diagram.
- The diagram follows the theme. Light and dark both use Orstra's own tokens.
- A diagram that mermaid cannot parse still shows its source, the way it does today.
- The 4 places that use `Markdown` get it at once: the task chat, the assistant chat, the
  side chat and a `.md` file in the viewer.

## Non-goals

- No pan, no zoom, no fullscreen. The diagram scrolls sideways inside the message.
- No export to SVG or PNG.
- No diagram editor, and no diagram in what you type. Your own messages stay plain text.
- No other diagram syntax (PlantUML, Graphviz).

## Anti-goals

- Untrusted text must not run in Orstra's origin. A message comes from an agent, and an
  agent reads the web. Mermaid keeps `securityLevel: 'strict'`, and `htmlLabels` stays
  off, so a label is text and never markup.
- A broken diagram must not lose the message. The source stays readable.
- Mermaid must not land in the main bundle. It is about 20 times the size of the rest of
  the UI, and most messages have no diagram.

## Approaches considered

1. **Mermaid, loaded with the page.** One import, no states to hold. Rejected: every page
   load pays for a library that few messages need.
2. **Mermaid, loaded the first time a diagram shows (picked).** A dynamic `import('mermaid')`
   inside the diagram component. Vite puts it in its own chunk. The cost falls on the
   message that has a diagram.
3. **Draw in the daemon and send an SVG.** It would keep the browser small, but mermaid
   needs a DOM, so the daemon would need a headless browser. Rejected.
4. **An iframe per diagram.** Strongest isolation, but 1 frame per diagram, no shared
   theme, and the height has to be measured. Rejected: `securityLevel: 'strict'` with no
   HTML labels already keeps labels to text.

## Design

### `apps/web/src/components/Mermaid.tsx` (new)

One diagram. It holds 3 states: the source (also what the server renders), the drawn SVG,
and a failure.

- An effect loads mermaid, initializes it with the config for the theme, and calls
  `mermaid.render`. The SVG goes into state and is set with `dangerouslySetInnerHTML`,
  which is how mermaid hands a drawing over.
- Before the drawing arrives, and when it fails, the component renders the same code block
  the chat shows today (`ox-mdcode`), so nothing is lost on the way.
- A failure adds one quiet line above the source, with the message mermaid gave.
- The effect runs again when the theme changes, so a diagram redraws in the new palette.

### `apps/web/src/lib/mermaidTheme.ts` (new)

`mermaidConfig(theme, token)` builds the mermaid config. `token(name)` reads one CSS
variable, so the palette has one home: `styles.css`. The browser passes a reader over
`getComputedStyle(document.documentElement)`; a caller with no DOM passes its own. Pure,
so it is tested on its own.

Tokens used: `--surface` for the ground, `--accent-soft` / `--accent-line` / `--ink` for a
node, `--fill` and `--surface-2` for the second and third fills, `--dim` for a line,
`--ink-2` for text, `--font` for the face. `darkMode` follows the theme so mermaid derives
its own shades on the right side of the ground.

### `apps/web/src/components/Markdown.tsx`

The `pre` override already reads the language of a fenced block. When the language is
`mermaid` it renders `<Mermaid>` instead of the code block. The rest is unchanged.

### `apps/web/src/lib/theme.ts`

Export the store's `subscribe` as `subscribeTheme`, so a component can follow the theme
without `useSyncExternalStore`. The web tests render with `renderToStaticMarkup`, and that
hook needs a server snapshot on the server.

### `apps/web/src/styles.css`

`.ox-mermaid`: the ground, a border and a radius like `.ox-mdcode`, and
`overflow-x: auto` so a wide diagram scrolls inside the message. `.ox-mermaid svg`:
`max-width: none` and `height: auto`. `.ox-mermaid-err`: one quiet line in `--red-fg`.

### `apps/web/package.json`

Add `mermaid` (11.x).

## Verification

- `apps/web/test/mermaidTheme.test.ts`: the config for each theme, the tokens it reads,
  the fallback when a token is missing, and that `securityLevel` stays strict with no HTML
  labels.
- `apps/web/test/markdown.test.ts`: a ```mermaid fence renders the diagram container with
  its source; another language still renders the code block; the source stays escaped.
- `npm test` and `npm run typecheck` at the root, and `npm run build` for the web bundle,
  which also shows that mermaid is a chunk of its own.
- By hand: ask the assistant for a flowchart, in both themes.

## Left open

- The drawn diagram replaces the source, so a slow first load shows the source for a
  moment. A spinner was considered and dropped: the source is more use than a spinner.
- Pan and zoom, and a copy button, if a real diagram turns out to be too wide to read.
