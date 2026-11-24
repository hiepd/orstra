# Chat side viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the worktree panel of a task's Chat view with a tabbed side viewer that opens the agent's references (links, artifacts, .md files, images) and 6 panels (Changes, Browser, Files, Terminal, Side chat, Artifacts), with split, right-click and expand.

**Architecture:** The daemon gets 4 small modules (files, link info, terminals, dev servers) behind the existing guard. The terminal streams over SSE and takes input by JSON POST. The web gets a `viewer/` folder: a pure state reducer kept in `localStorage`, a `Viewer` shell, and one component per panel. `TaskChat` hosts it in place of `GitPanel`.

**Tech Stack:** Node 22 `node:http` daemon (no framework), `node-pty` 1.1.0, React 18 + Vite, `@xterm/xterm` 6.0.0 + `@xterm/addon-fit` 0.11.0, vitest 2.

**Spec:** `docs/superpowers/specs/2026-11-24-chat-side-viewer-design.md`

## Global Constraints

- Every new `/api/` route goes through `refuseReason` (it does, by being under `/api/`). Routes that change state are POST with a JSON body.
- File bytes go out with `x-content-type-options: nosniff` and `content-security-policy: default-src 'none'; sandbox`, as `sendAttachment` does.
- File reads stay inside the worktree, after `realpath`. Cap: 10 MB. File list cap: 5000 paths.
- Link info: http and https only, 5 s timeout, first 64 KB for the title, cache 10 minutes.
- Terminal scrollback kept: 256 KB for each terminal.
- At most 2 panes. The chat keeps `min-width: 380px` unless the viewer is expanded.
- UI copy follows `docs/design.md` (plain, short sentences). The artboard (canvas version 30) is the visual reference.
- The daemon kills all terminals and dev servers on exit, and a task's ones before a worktree cleanup.

## Review Focus

- A path with `..`, an absolute path, or a symlink that points out of the worktree: the file route answers 404, never the bytes. (Task 1 test.)
- A task with no worktree yet, or a removed worktree: files, terminal and dev server routes answer a sentence, not a crash. (Tasks 1, 3, 4 tests.)
- `node-pty` fails to load (no prebuild for the platform): the terminal route answers 503 with the reason, the daemon stays up. (Task 3 test with an injected loader.)
- A dev server command that exits at once or prints no URL: status `exited` with the last log lines; a printed URL with `0.0.0.0` or `[::]` becomes `localhost`. (Task 4 test.)
- A message that names a path inside a code fence, a URL with a closing `)` or `.` after it, or the same reference 2 times: the chips show each reference once, without the trailing punctuation. (Task 5 test.)

---

### Task 1: Worktree files (daemon)

**Files:**
- Create: `apps/daemon/src/files.ts`
- Modify: `apps/daemon/src/server.ts` (routes after the `/diff` route)
- Test: `apps/daemon/test/files.test.ts`

**Interfaces:**
- Produces: `listFiles(worktree: string): { paths: string[]; truncated: boolean }`, `readWorktreeFile(worktree: string, rel: string): { body: Buffer; mime: string; name: string } | null`, `mimeOf(path: string): string`, `MAX_VIEW_BYTES = 10 * 1024 * 1024`.
- Routes: `GET /api/tasks/:id/files` → `{ paths, truncated }`; `GET /api/tasks/:id/file?path=` → bytes.

- [ ] **Step 1: Write the failing tests** in `files.test.ts` with a temp git repo (`git init`, a committed `docs/a.md`, an untracked `img/b.png`, an ignored `node_modules/x.js` with `.gitignore`):
  - `listFiles` returns `['.gitignore', 'docs/a.md', 'img/b.png']` (sorted), `truncated: false`.
  - `readWorktreeFile(dir, 'docs/a.md')` returns the text and mime `text/markdown; charset=utf-8`.
  - `readWorktreeFile(dir, '../outside.txt')`, `readWorktreeFile(dir, '/etc/hosts')`, and a symlink `docs/link -> /etc/hosts` all return `null`.
  - A missing file returns `null`. A directory returns `null`.
- [ ] **Step 2: Run** `npx vitest run apps/daemon/test/files.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement `files.ts`.** `listFiles` runs `git ls-files -co --exclude-standard -z` with `execFileSync` (cwd = worktree), splits on `\0`, sorts, caps at 5000. `readWorktreeFile` uses `realpathSync` on both the worktree and the target and checks `target.startsWith(root + sep)`; size from `statSync`, refuse over 10 MB. `mimeOf` covers md, txt, json, yaml, ts, tsx, js, css, html (as `text/plain` so it never renders), png, jpg, jpeg, gif, webp, svg, pdf; else `application/octet-stream`.
- [ ] **Step 4: Add the routes** in `server.ts`. No task or no worktree → 404 `{ error }`. The file route reuses the header set of `sendAttachment` (factor the header write into `sendBytes(res, {body, mime, name})`).
- [ ] **Step 5: Add a route test** in `apps/daemon/test/server.test.ts`: `GET /api/tasks/:id/file?path=..%2Fx` → 404; a file in the worktree → 200 with `x-content-type-options: nosniff`.
- [ ] **Step 6: Run** `npx vitest run apps/daemon/test/files.test.ts apps/daemon/test/server.test.ts`. Expected: PASS.
- [ ] **Step 7: Commit** `Read worktree files for the side viewer`.

### Task 2: Link info (daemon)

**Files:**
- Create: `apps/daemon/src/linkInfo.ts`
- Modify: `apps/daemon/src/server.ts`
- Test: `apps/daemon/test/linkInfo.test.ts`

**Interfaces:**
- Produces: `frameableFrom(headers: Headers): boolean`, `titleFrom(html: string): string | null`, `linkInfo(url: string, fetcher?: typeof fetch): Promise<{ url: string; frameable: boolean; title: string | null }>`.
- Route: `GET /api/link-info?url=` → that object; a URL that is not http or https → 400.

- [ ] **Step 1: Write the failing tests:**
  - `frameableFrom` is false for `x-frame-options: DENY` and `SAMEORIGIN`, false for CSP `frame-ancestors 'none'` and `frame-ancestors 'self'`, true for `frame-ancestors *`, true with no header.
  - `titleFrom('<title> Saved &amp; searches </title>')` is `Saved & searches`; no title → null.
  - `linkInfo` with a stub fetcher that throws → `{ frameable: false, title: null }`. Calls for the same URL inside 10 minutes call the fetcher once.
  - `linkInfo('file:///etc/hosts')` rejects.
- [ ] **Step 2: Run** `npx vitest run apps/daemon/test/linkInfo.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** with `AbortSignal.timeout(5000)`, `redirect: 'follow'`, a reader that stops at 64 KB. Decode the 5 common entities only.
- [ ] **Step 4: Add the route.** Run the tests. Expected: PASS.
- [ ] **Step 5: Commit** `Tell the viewer whether a link can show in a frame`.

### Task 3: Terminals (daemon)

**Files:**
- Create: `apps/daemon/src/terminals.ts`
- Modify: `apps/daemon/package.json` (dependency `node-pty: 1.1.0`), `apps/daemon/src/server.ts`, `apps/daemon/src/cli.ts` (kill on exit)
- Test: `apps/daemon/test/terminals.test.ts`

**Interfaces:**
- Produces: `class Terminals extends EventEmitter` with `constructor(opts?: { load?: () => Promise<PtyModule>; shell?: string })`, `open(taskId: string, cwd: string): Promise<TerminalInfo>`, `list(taskId: string): TerminalInfo[]`, `get(id: string)`, `write(id, data: string)`, `resize(id, cols: number, rows: number)`, `close(id)`, `closeTask(taskId)`, `closeAll()`. Events: `data` `(id, chunk: string)`, `exit` `(id, code: number)`.
- `TerminalInfo = { id: string; taskId: string; title: string; cwd: string; alive: boolean; createdAt: number }`. `get(id)` also has `scrollback: string` (last 256 KB).
- Routes: `GET|POST /api/tasks/:id/terminals`, `GET /api/terminals/:tid/stream` (SSE; first event `{ type: 'data', data: scrollback }`, then `data` and `exit` events as JSON), `POST /api/terminals/:tid/input` `{ data }`, `/resize` `{ cols, rows }`, `/close`.

- [ ] **Step 1: Write the failing tests:**
  - With the real `node-pty` and `shell: '/bin/sh'`: `open` then `write(id, 'echo hi-orstra\n')` emits `data` that contains `hi-orstra`; `get(id).scrollback` contains it too; `close(id)` emits `exit`.
  - Scrollback keeps the last 256 KB only (write 300 KB through a stub pty).
  - With `load` that rejects: `open` rejects with a message that names `node-pty`.
  - `closeTask(taskId)` closes only that task's terminals.
- [ ] **Step 2: Run** `npx vitest run apps/daemon/test/terminals.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** The default loader imports `node-pty`, then `chmodSync(…/prebuilds/<platform>-<arch>/spawn-helper, 0o755)` in a try (npm drops the bit). Shell: `process.env.SHELL ?? '/bin/zsh'` with `['-l']`, `name: 'xterm-256color'`, `cols: 100, rows: 30`, `env: { ...process.env, TERM: 'xterm-256color' }`. Title: `Terminal N` per task.
- [ ] **Step 4: Add the routes.** POST open: no worktree → 400 `{ error: 'This task has no worktree yet.' }`; loader failure → 503 `{ error }`. The SSE handler sits in `startServer` beside `/api/events` (it holds the response open). Input body cap 64 KB. Server test: open → input `echo ok\n` → the stream shows `ok`.
- [ ] **Step 5: Kill on exit** in `cli.ts` (`process.on('exit'|'SIGINT'|'SIGTERM')` → `terminals.closeAll()`); pass the `Terminals` instance into `startServer` as an option with a default.
- [ ] **Step 6: Run** the terminal and server tests. Expected: PASS.
- [ ] **Step 7: Commit** `A real shell in the task's worktree`.

### Task 4: Dev servers (daemon)

**Files:**
- Create: `apps/daemon/src/devServers.ts`
- Modify: `apps/daemon/src/server.ts`, `apps/daemon/src/cli.ts`
- Test: `apps/daemon/test/devServers.test.ts`

**Interfaces:**
- Produces: `urlFromOutput(text: string): string | null`, `defaultCommand(worktree: string): string | null`, `class DevServers extends EventEmitter` with `status(taskId): DevServerView`, `start(taskId, cwd, command): Promise<DevServerView>`, `stop(taskId)`, `stopAll()`. Event `change` `(taskId)`.
- `DevServerView = { state: 'stopped' | 'starting' | 'running' | 'exited'; command: string | null; suggested: string | null; url: string | null; port: number | null; log: string; exitCode: number | null }` (`log`: last 80 lines).
- Routes: `GET /api/tasks/:id/devserver`, `POST /api/tasks/:id/devserver/start` `{ command? }`, `POST /api/tasks/:id/devserver/stop`. The server broadcasts `{ taskId }` on `change`, so the UI refetches.

- [ ] **Step 1: Write the failing tests:**
  - `urlFromOutput('  ➜  Local:   http://localhost:5173/\n')` → `http://localhost:5173/`; `http://0.0.0.0:3000` → `http://localhost:3000`; `http://[::]:8080` → `http://localhost:8080`; ANSI colour codes are stripped first; no URL → null.
  - `defaultCommand` → `npm run dev` with a `dev` script, `npm start` with only `start`, null with neither or no `package.json`.
  - `start(taskId, dir, 'node -e "console.log(\'http://localhost:\'+process.env.PORT); setInterval(()=>{},1000)"')` reaches `running` with the URL that holds the given `PORT`; `stop` reaches `stopped` and the process is gone (`process.kill(pid, 0)` throws).
  - A command that exits at once (`exit 3`) → `exited`, `exitCode: 3`.
- [ ] **Step 2: Run** `npx vitest run apps/daemon/test/devServers.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Free port: `net.createServer().listen(0)` then close. Spawn `sh -lc <command>` with `detached: true`, env `PORT`. If no URL in the output after the port accepts a TCP connection, use `http://localhost:<PORT>/` (poll every 500 ms, 60 s). Stop: `process.kill(-pid, 'SIGTERM')`, then `SIGKILL` after 3 s.
- [ ] **Step 4: Add the routes** and the kill on exit. The `/cleanup` route calls `terminals.closeTask` and `devServers.stop` before `cleanupWorktree`.
- [ ] **Step 5: Run** the tests. Expected: PASS.
- [ ] **Step 6: Commit** `Start the worktree's dev server for the Browser panel`.

### Task 5: References in messages (web)

**Files:**
- Create: `apps/web/src/lib/refs.ts`
- Test: `apps/web/test/refs.test.ts`

**Interfaces:**
- Produces: `type RefKind = 'link' | 'artifact' | 'browser' | 'md' | 'image'`, `type Ref = { kind: RefKind; target: string; label: string }`, `findRefs(text: string): Ref[]`, `refTab(ref: Ref): TabId` (from Task 6: `link:<url>` for link, artifact and browser; `file:<path>` for md and image).

- [ ] **Step 1: Write the failing tests:**
  - `https://linear.app/acme/issue/HUB-402).` → one `link` with target `https://linear.app/acme/issue/HUB-402`, label `linear.app/acme/issue/HUB-402`.
  - `https://claude.ai/artifact/5YZD` → `artifact`. `http://localhost:5401/search` → `browser`.
  - `` `docs/specs/saved-searches.md` `` and plain `.orstra/artifacts/spec/empty-state.png` → `md` and `image`, label = the file name.
  - The same URL 2 times → 1 ref. A path inside a fenced code block is still found (agents write paths in fences); a path with `://` is not a file.
  - Absolute paths outside a worktree (`/etc/x.md`) are left out; `./docs/a.md` becomes `docs/a.md`.
- [ ] **Step 2: Run** `npx vitest run apps/web/test/refs.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** with 2 regexes (URLs; relative paths ending in `.md|.markdown|.png|.jpg|.jpeg|.gif|.webp|.svg`), trailing `.,;:!?)]'"` stripped, order of first sight kept.
- [ ] **Step 4: Run** the test. Expected: PASS.
- [ ] **Step 5: Commit** `Find the references in an agent's message`.

### Task 6: Viewer state (web)

**Files:**
- Create: `apps/web/src/components/viewer/state.ts`, `apps/web/src/components/viewer/useViewer.ts`
- Modify: `apps/web/src/api.ts` (calls for Tasks 1–4)
- Test: `apps/web/test/viewerState.test.ts`

**Interfaces:**
- Produces in `state.ts`: `type TabId = string`, `type Pane = { tabs: TabId[]; active: TabId | null }`, `type ViewerState = { panes: Pane[]; focus: number; dir: 'row' | 'column'; expanded: boolean; open: boolean }`, `initialViewer(): ViewerState` (`panes: [{ tabs: ['changes'], active: 'changes' }]`, `open: true`), and `reduce(s: ViewerState, a: ViewerAction): ViewerState` with actions `open {tab}`, `pick {pane, tab}`, `close {pane, tab}`, `closeOthers {pane, tab}`, `split {pane, tab, dir}`, `move {pane, tab}`, `unsplit`, `setDir {dir}`, `toggleExpand`, `toggleOpen`.
- Produces in `useViewer.ts`: `useViewer(taskId: string): [ViewerState, (a: ViewerAction) => void]`, stored under `orstra.viewer.<taskId>`; `openInViewer(taskId, tab)` for the Inbox (writes a pending `open` that `useViewer` applies on mount).
- Produces in `api.ts`: `api.files(taskId)`, `worktreeFileUrl(taskId, path)`, `api.linkInfo(url)`, `api.terminals(taskId)`, `api.openTerminal(taskId)`, `api.terminalInput(tid, data)`, `api.terminalResize(tid, cols, rows)`, `api.closeTerminal(tid)`, `terminalStreamUrl(tid)`, `api.devServer(taskId)`, `api.startDevServer(taskId, command?)`, `api.stopDevServer(taskId)`, with the types `TerminalInfo` and `DevServerView` from Tasks 3–4.

- [ ] **Step 1: Write the failing tests** that copy the artboard's checked paths:
  - `open` a tab that is in pane 1 makes it active there and sets `focus: 1`; a new tab goes into the focused pane.
  - `split {dir:'column'}` with 2 tabs → 2 panes, the tab moved, `dir: 'column'`, `focus: 1`; with 1 tab → the tab in both panes.
  - `move` from pane 0 → pane 1; when the source pane becomes empty it goes away.
  - `close` of the last tab of pane 1 → 1 pane; `unsplit` merges without duplicates and keeps the focused pane's active tab.
  - `split` when 2 panes exist does nothing (2 panes at most).
  - `toggleExpand` with `open: false` sets `open: true` too.
- [ ] **Step 2: Run** `npx vitest run apps/web/test/viewerState.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `state.ts` (pure, no React) and `useViewer.ts` (reads and writes `localStorage` in try/catch, like `lib/remember`). Add the API calls.
- [ ] **Step 4: Run** the test and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `Viewer state: panes, tabs, split and expand`.

### Task 7: The viewer shell in the Chat view (web)

**Files:**
- Create: `apps/web/src/components/viewer/Viewer.tsx`, `apps/web/src/components/viewer/tabs.ts` (label, icon, colour for each `TabId`), `apps/web/src/components/viewer/ChangesPanel.tsx`, `apps/web/src/components/RefChips.tsx`
- Modify: `apps/web/src/pages/TaskChat.tsx`, `apps/web/src/components/GitPanel.tsx` (export the body as `GitBody` for `ChangesPanel`; keep `useGit`, `DiffView`), `apps/web/src/components/Transcript.tsx` (chips under each agent message; hide `ask` and `aside` events, which move to Side chat), `apps/web/src/components/Markdown.tsx` (an optional `onLink(url, e)` prop: a plain click calls it, a ⌘-click or middle click keeps the new tab), `apps/web/src/styles.css`

**Interfaces:**
- Consumes: Task 5 `findRefs`, `refTab`; Task 6 `useViewer`, `reduce` actions.
- Produces: `<Viewer task={TaskDetail} git={Resource<GitView>} state={ViewerState} dispatch={…} />` and a panel contract `PanelProps = { task: TaskDetail; tab: TabId; dispatch }` that Tasks 8–9 fill. Until then, unknown tabs show "Coming in this build" so the shell works alone.

- [ ] **Step 1: Build the shell** to the artboard: each pane has a tab strip (`role="tablist"`), a + button with a `role="menu"` of the 6 panels (label, meta, shortcut), and a split button (Split right, or Close the split). The pane at the top right has Expand (`aria-pressed`). Right-click on a tab opens the menu from the artboard (Split right, Split down; once split: Move to the <side> pane, Stack the panes or Put the panes side by side, Close the split; then Close, Close other tabs). Escape and an outside click close it. A double-click on a tab expands.
- [ ] **Step 2: Host it in `TaskChat`** in place of `GitPanel`: the chat keeps `min-width: 380px`; when expanded the chat section is hidden. A viewer toggle sits at the top right of the chat. The shortcuts from the spec are bound on `window` while the Chat view shows (skip when focus is in a text field, except ⌘\\).
- [ ] **Step 3: Chips and links.** `RefChips` under each `message` event, with the artboard's 3 looks (link chip, MD chip, image preview with `worktreeFileUrl`, artifact card). A click dispatches `open {tab: refTab(ref)}`. In the Inbox (`embedded`), a click calls `openInViewer` and navigates to `href.chat(task.id)`.
- [ ] **Step 4: Check by hand** with `npm run dev` against a test daemon (the scratch home with `fake-claude.mjs`): open, split right and down, move, unsplit, expand, the chat at 380 px. Run `npm run typecheck` and `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `Side viewer in the Chat view: tabs, split, expand`.

### Task 8: File, link, artifact, Files, Artifacts and Side chat panels (web)

**Files:**
- Create: `apps/web/src/components/viewer/FilePanel.tsx`, `LinkPanel.tsx`, `FilesPanel.tsx`, `ArtifactsPanel.tsx`, `SideChatPanel.tsx`
- Modify: `apps/web/src/components/viewer/Viewer.tsx` (route each `TabId` to its panel), `apps/web/src/styles.css`

**Interfaces:**
- Consumes: Task 6 API calls, Task 5 `findRefs`, Task 7 `PanelProps`, `Markdown`, `Composer`.

- [ ] **Step 1: `FilePanel`** for `file:<path>`: markdown with Rendered or Source (fetch the text from `worktreeFileUrl`), an image with Fit or 100% on a checker background, other text in a `<pre>` with line numbers, a binary file as a card. Toolbar: the path, and "Copy path". 404 → "This file is not in the worktree now."
- [ ] **Step 2: `LinkPanel`** for `link:<url>`: back, reload, the URL, "Open in browser" (or "Open in claude.ai" for an artifact). `api.linkInfo` decides: frameable → `<iframe sandbox="allow-scripts allow-same-origin allow-forms allow-popups" referrerpolicy="no-referrer">`; else a card with the title and the open button. A `localhost` URL always frames (it is the dev server).
- [ ] **Step 3: `FilesPanel`**: a tree from `api.files` (folders fold, the changed files from `git` carry A/M/D), a filter field, a click opens `file:<path>`. "truncated" → a line that says only the first 5000 show.
- [ ] **Step 4: `ArtifactsPanel`**: the refs of kind artifact, image and md from all `message` events of the task, plus the paths under `.orstra/artifacts/`, newest first, each with its step title. A click opens the tab.
- [ ] **Step 5: `SideChatPanel`**: the `you` events with mode `ask` and the `aside` events of the chat's run, and a `Composer` that sends `api.message(taskId, { text, mode: 'ask', runId })`. The top line says the run is not touched and the task does not move.
- [ ] **Step 6: Check by hand** each panel with the test daemon. Run `npm run typecheck` and `npm test`. Expected: PASS.
- [ ] **Step 7: Commit** `Viewer panels: files, links, artifacts, side chat`.

### Task 9: Terminal and Browser panels (web)

**Files:**
- Create: `apps/web/src/components/viewer/TerminalPanel.tsx`, `apps/web/src/components/viewer/BrowserPanel.tsx`
- Modify: `apps/web/package.json` (`@xterm/xterm` 6.0.0, `@xterm/addon-fit` 0.11.0), `Viewer.tsx`, `styles.css`

**Interfaces:**
- Consumes: Task 3 routes through Task 6 API calls; Task 4 routes likewise.

- [ ] **Step 1: `TerminalPanel`**: on mount, use the task's first live terminal or open one. An `EventSource(terminalStreamUrl(tid))` writes `data` events into xterm; xterm `onData` posts input (batch keys for 16 ms); `FitAddon` plus a `ResizeObserver` post the size. Toolbar: the cwd, "New terminal", and "Send the last output to the chat" (puts the selection, or the last 40 lines, in the composer as a fenced block). Exit → "The shell ended" with "Start again". 503 → the daemon's reason.
- [ ] **Step 2: `BrowserPanel`**: state from `api.devServer` (refetch on live changes). Stopped → the suggested command in an editable field and Start. Starting → the log tail. Running → a status line (command, port, Restart, Stop) and an iframe of the URL with an address field for other paths on that origin. Exited → the exit code, the log tail, and Start again.
- [ ] **Step 3: Check by hand**: a shell runs `ls` and `git status` in the worktree; the dev server of a small Vite app in the scratch worktree starts and shows. Run `npm run typecheck` and `npm test`. Expected: PASS.
- [ ] **Step 4: Commit** `Viewer panels: terminal and browser`.

### Task 10: Docs and a full check

**Files:**
- Modify: `docs/concepts.md` (the viewer, Side chat), `docs/design.md` (the viewer layout rules: 2 panes, 380 px, expand), `README.md` if it lists the Chat view's panels

- [ ] **Step 1: Write the docs** in the house style.
- [ ] **Step 2: Run** `npm run typecheck && npm test && npm run build`. Expected: all pass.
- [ ] **Step 3: Check the whole flow** in the browser pane against the test daemon: chips open tabs, split, right-click, expand, each panel.
- [ ] **Step 4: Commit** `Docs: the chat side viewer`.
