# Chat side viewer: design

Date: 2026-11-24. Status: approved (the artboard "Chat · side viewer" on the redesign canvas, version 30, and "Everything in the artboard" for scope).

## Why

An agent's messages name things: a ticket URL, a spec it wrote, a screenshot, a Claude artifact, a dev server. Today you leave Orstra to look at them, or you do not look. A standard coding tool shows them beside the chat. Orstra must do the same, so that you review the work where you steer it.

## Goals

- References in the agent's messages show as chips. A click opens the reference in a viewer on the right, in a tab.
- The viewer replaces the worktree panel of the Chat view. Changes is its first tab.
- A + menu opens 6 panels: Changes, Browser, Files, Terminal, Side chat, Artifacts.
- Split: 2 panes at most, side by side or stacked. Right-click a tab to split, move, change the layout, or close.
- Expand: the viewer covers the chat. The same control shows the chat again.
- Terminal: a real shell in the task's worktree.
- Browser: Orstra starts the worktree's dev server and shows it in a frame.

## Non-goals

- No editor. Files are read-only. You edit in your own editor ("Open in editor").
- No more than 2 panes. No drag and drop of tabs between panes.
- No viewer in the Inbox split (the task pane there is too narrow). A chip there opens the full Chat view with the tab.
- No iOS Simulator panel. No Background tasks panel.

## Anti-goals

- The viewer must not make the chat unusable. The chat keeps 380 px or more, unless you expand the viewer.
- A web page must not get a shell. Terminal and dev-server routes go through the same guard as every other route (Host, Origin, JSON content type, no cross-site fetch).
- Untrusted content must not run in Orstra's origin. File bytes go out with `nosniff` and a sandbox CSP. A link or an artifact shows in a sandboxed iframe.

## Approaches considered

1. **Tabs in the chat column (no side viewer).** Cheap, but you lose the chat while you look. Rejected: it works against the reason for the feature.
2. **A side viewer with tabs and at most 1 split (picked).** It matches standard coding tools and the artboard. The state stays small: 2 panes, each with a tab list.
3. **A free layout with docking.** Strong, but it needs a layout library and many states that people do not use. Rejected for now.

For the Terminal, a WebSocket and a pure pipe shell were also considered:

- A pure pipe (no pty) gives no prompt, no colours, and no full-screen programs. Rejected.
- A WebSocket needs a new dependency in the daemon (`ws`) and a second guard path. Rejected.
- **Picked:** `node-pty` for the shell, Server-Sent Events for output, and JSON POST for input and resize. This uses the existing guard and the existing SSE pattern.

## Design

### Web

New folder `apps/web/src/components/viewer/`:

- `useViewer(taskId)`: the state. It holds `panes: { tabs: TabId[]; active: TabId | null }[]` (1 or 2), `focus` (the pane you used last), `dir` (`row` or `column`), `expanded`, and `open` (the viewer shows or not). It is kept in `localStorage` for each task.
- `TabId` is a string: `changes`, `files`, `browser`, `terminal`, `side`, `artifacts`, `file:<path>`, or `link:<url>`.
- `Viewer`: the panes, each with a tab strip, the + menu, the split button, and (on the pane at the top right) the Expand button. It also holds the right-click menu of a tab.
- Panels: `ChangesPanel` (the body of today's `GitPanel`), `FilesPanel` (a tree), `FilePanel` (markdown Rendered or Source, image Fit or 100%, text with line numbers), `LinkPanel` (link and artifact), `BrowserPanel`, `TerminalPanel` (`@xterm/xterm`), `SideChatPanel`, `ArtifactsPanel`.
- `lib/refs.ts`: finds references in a message. It finds `http(s)` URLs (a `claude.ai/artifact/…` URL is an artifact, a `localhost` URL is the browser), and relative paths to `.md` and image files. `RefChips` shows them under the message.
- A plain click on a link in a message opens it in the viewer. A ⌘-click opens it in a new browser tab.

Rules:

- A reference opens in the pane you used last. If its tab is open in a pane, that tab becomes active.
- Split right or Split down moves the tab to a new pane. A pane with 1 tab shows the tab in both panes.
- When you close the last tab of a pane, the pane closes.
- Shortcuts: ⌘\\ expands. ⇧⌘D, ⇧⌘B, ⇧⌘F, ⌘J and ⌘; open Changes, Browser, Files, Terminal and Side chat. The browser keeps ⌘W, so Close shows no shortcut.
- Side chat sends in `ask` mode. Its questions and answers (events `you` with mode `ask`, and `aside`) show in the Side chat panel, not in the main chat.
- Artifacts lists, newest first: the Claude artifacts and files that the task's messages name, and the files under `.orstra/artifacts/`.

### Daemon

New modules, each with tests:

- `files.ts`
  - `listFiles(worktree)` uses `git ls-files -co --exclude-standard -z`, with a cap of 5000 paths.
  - `readWorktreeFile(worktree, path)` resolves the real path and refuses anything outside the worktree, including through a symlink. It caps the size at 10 MB and gives the MIME type from the extension.
- `linkInfo.ts`: `linkInfo(url)` gets the page (http and https only, 5 s timeout). It reads `X-Frame-Options` and the CSP `frame-ancestors`, and takes the `<title>` from the first 64 KB. The result is kept for 10 minutes.
- `terminals.ts`: `Terminals` starts a login shell in the worktree with `node-pty`. It keeps the last 256 KB of output, so a page that comes back sees the screen. It makes `spawn-helper` executable at the start, because npm drops the execute bit. If `node-pty` does not load, the panel shows the reason.
- `devServers.ts`: `DevServers` starts one command for each task in its worktree (`sh -lc`, in its own process group), with a free `PORT` in the environment. It finds the URL in the output, or uses that `PORT`. The default command comes from the worktree's `package.json`: `npm run dev`, else `npm start`. Stop kills the process group.

New routes:

| Route | Does |
| --- | --- |
| `GET /api/tasks/:id/files` | The worktree's paths |
| `GET /api/tasks/:id/file?path=` | One file's bytes, `nosniff`, sandbox CSP |
| `GET /api/link-info?url=` | `{ frameable, title }` |
| `GET /api/tasks/:id/terminals`, `POST` the same | List, open |
| `GET /api/terminals/:tid/stream` | SSE: the kept output, then the new output |
| `POST /api/terminals/:tid/input`, `/resize`, `/close` | Keys, size, close |
| `GET /api/tasks/:id/devserver` | Status, URL, command, last log lines |
| `POST /api/tasks/:id/devserver/start`, `/stop` | Start (with a command), stop |

The daemon stops all terminals and dev servers when it exits. A cleanup of the worktree stops the task's terminals and dev server first.

## Left to the builder

- The exact look follows the artboard and the tokens in `styles.css`.
- The test split between pure functions (refs, URL search in output, path checks) and route tests.
