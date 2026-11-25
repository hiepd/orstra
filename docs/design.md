# Orstra design

Orstra is a local software factory. Coding agents (Claude Code, Codex) run custom workflows on your tasks, mostly Linear tickets, on your own machine. You stay out of the loop except where a workflow asks for you, and you can talk to any agent at any time.

Mock (all screens): https://claude.ai/artifact/6ekxsGvdsWrBfEEoyyv3Ce

## Goals

- Custom workflows, not a fixed SDLC. A workflow is a graph of steps you draw or write as YAML.
- Runs locally: your credentials, your checkouts, your Claude Code and Codex setup (skills, hooks, MCP).
- Calm by default. You see what needs you; healthy work is a count, not a wall of cards.
- Every agent is reachable at every moment: steer, interrupt, ask on the side, or open the session in Claude Code.

## Non-goals (for now)

- Running in the cloud or for a whole team.
- Merging without a human. A merge or a pull request comes only after a `human` step that you answer. The Simple workflow (Todo, In progress, In review, then done) merges nothing; a workflow can merge locally (`git.merge`) or open a draft pull request (`github.pr`) after your decision.
- Its own coding agent. Orstra orchestrates existing CLIs.

## Concepts

Task, workflow, step, trigger, run, session, outcome, progress entry, note and decision are defined in [concepts.md](concepts.md), along with which screen is each one's home. Use those words exactly.

## The rules we settled

1. **The workflow is a state machine with capped loops, not a DAG.** Every step ends with exactly one outcome; each arrow out of a step is labeled with an outcome; Orstra follows the matching arrow. Backward arrows (retries, "changes requested") must declare a cap. Cap reached, no matching arrow, timeout, budget reached, or `needs_you` → the task goes to your Inbox. Nothing is ever silently stuck, and nothing silently passes: an agent turn with no `OUTCOME:` line is not `done`, and an unknown action name is a parse error.
2. **The task persists; sessions don't.** Every run of a step is a fresh session, retries included. Continuity comes from the task's progress entries, the worktree and git. Workflows also chain into each other through triggers.
3. **Hand-offs live in the task's progress, not in files.** Each run ends by writing a progress entry (Did / Decided / Left / Avoid). The next session starts from those entries. Entries are mirrored to the ticket's source (e.g. a Linear comment), summaries only.
4. **Human steps are decisions with consequences.** A human step shows what you decide about (e.g. the spec), the artifacts the steps produced, the agent's assumptions and open questions, and what each choice does. Each choice is an outgoing arrow.
5. **One session, two windows.** Agent steps run as Claude Code sessions with a known session id. "Open in Claude Code" resumes or attaches to that same session; "Ask on the side" uses a fork (`--fork-session`). Your messages (steer, interrupt, notes) are recorded in the task progress.
6. **Progressive disclosure in the UI.** The main decision first; detail in side panels, modals and menus.

## Architecture

```
apps/web      React + Vite UI (Linear-style), talks to the daemon over HTTP + SSE
apps/daemon   Node daemon: HTTP API, SSE events, runner, SQLite store, CLI
packages/core Workflow schema + parser, outcome routing, templating (pure, tested)
workflows/    Default workflows, copied into ~/.orstra/workflows/ on first run (the daemon loads only that folder)
```

- **Store:** SQLite via Node's built-in `node:sqlite` at `~/.orstra/orstra.db` (no native deps).
- **Runner:** a slot-limited scheduler. A task's next step is queued; a free slot picks it up.
- **Agent runs:** `claude -p … --output-format stream-json --session-id <uuid>` in the task's worktree. Stream events become the session's activity. The final message carries the progress entry and an `OUTCOME:` line.
- **Gate runs:** shell commands in the worktree; exit code 0 → `pass`, else `fail`.
- **Worktrees:** when a workflow names a repo, each task gets `git worktree add ~/.orstra/wt/<task> -b orstra/<task>`.
- **API:** REST for tasks, runs, sessions, decisions, messages; SSE `/api/events` for live updates (at most one message per task per 100 ms). The task API can send only the events after a given id.
- **API guard:** the daemon listens on 127.0.0.1 and refuses a request whose `Host` is not this machine, whose `Origin` is not Orstra's UI, or that changes something without `content-type: application/json` (`apps/daemon/src/guard.ts`). Without this, any web page could send a command to the assistant. The CLI and the MCP servers send no `Origin`, so they pass.
- **Viewer routes:** `GET /api/tasks/:id/files` and `/file?path=` read the worktree, then the git repositories that the task's agents read or edited files in (taken from their tool calls; a task with no repo gets an empty scratch folder, and its agent may work in another checkout). A path stays inside one of those folders after `realpath`, 10 MB at most, sent with `nosniff` and a sandbox CSP. `GET /api/link-info` says whether a site lets other pages frame it. Terminals run a login shell on a pty (`node-pty`, `apps/daemon/src/terminals.ts`): output streams as SSE, keys come as JSON POST, so they pass the same guard. Dev servers (`apps/daemon/src/devServers.ts`) run one command per task in its own process group with a free `PORT`.
- **Artifacts:** any agent or gate run may write under `.orstra/artifacts/`; a step can also name `artifacts:` globs at other paths. Artifacts never block: they change no outcome and no route. When the run ends the runner copies each new match to `~/.orstra/artifacts/<task>/<run>/`, records a row, and serves it from `/api/artifacts/:id`. Before the next agent or gate run it stages the newest kept files of each earlier step at `.orstra/inputs/<step>/` and lists them in the prompt. The bytes stay out of the database and out of the user's branch.
- **Workflow copy:** a task stores the workflow YAML it started with. An edit to the file changes new tasks only, until you move a task to the new version.

## What is built

- Engine: parse a workflow, start a task by hand (CLI or UI) or from a trigger, run agent / gate / human / switch / action steps, route outcomes with capped loops, record runs, sessions, events, progress, artifacts, cost and tokens. You can message a running agent, stop its turn, and reopen an ended session; a message to an ended session sends that step back to its agent while the task is still open. A task's state is read from its run rows, which is why 1 run at a time holds a task (`apps/daemon/src/project.ts`). Steps have timeouts (`timeout:`, default 120 min for agents and 30 min for gates). A workflow can cap a task's cost (`budget_usd`) and how many of its tasks work at once (`concurrency`).
- Agents: Claude Code (`claude -p`, stream-json) and Codex (`codex exec --json`, one process per turn). A Claude Code tool call that the permission mode does not allow comes to the Inbox as a question (`apps/daemon/src/perm-mcp.ts`).
- Actions: `git.merge` merges the task branch into the branch the repository has checked out (local, never forced, never pushed). `github.pr` pushes the task branch and opens a draft pull request with `gh`. `git.cleanup` removes the worktree, and the branch when merged.
- Triggers: 1 YAML file each in `~/.orstra/triggers`, naming the workflow it starts (`apps/daemon/src/triggerFiles.ts`), plus imperative schedules in the database (`apps/daemon/src/schedules.ts`). Kinds: `linear` (one task per open issue with a label; progress entries go back as comments) and `schedule` (cron with a timezone, or an interval). An old `triggers:` list in a workflow file moves into trigger files on the next check.
- Assistant: a long-running Claude Code session with Orstra's tools (an MCP server, `apps/daemon/src/cos-mcp.ts`, that forwards to the daemon) and its own, with no limit on either. The flags are 4 (`cosToolArgs` in `apps/daemon/src/cos-tools.ts`): `--mcp-config`, `--strict-mcp-config`, `--permission-mode bypassPermissions`, `--add-dir`, plus the system prompt. The daemon enforces what needs your OK for Orstra's tools; gated actions become plans. Its own files and commands pass no gate and write no run row. `bypassPermissions` is what makes Orstra's tools work at all: the daemon answers no permission request, and Claude Code then refuses the call. Measured with `--mcp-config` alone, it refused `mcp__orstra__list_tasks`. The built-in set is the machine's, so some machines have no Glob and no Grep; the prompt says to search with Bash. Watches wake it when a task reaches a state.
- UI: the assistant page, then three places (see [concepts.md](concepts.md)):
  - **Tasks**, three views. **Inbox**: tasks that need you across workflows, grouped by decision, agent waiting, stuck, with the selected task (Overview or Chat) open beside the list. **Board** (columns are one workflow's steps) and **List** (grouped by status). The sidebar's Tasks item carries the count of what needs you and opens the Inbox when something waits.
  - **Task page**, two views. **Overview**: where the task is, what happens next, the decision if one is waiting, every run with its progress note, and notes for upcoming steps. **Chat**: the task's sessions, the conversation with the selected one, and the viewer: tabs for the references in the agent's messages (links, artifacts, `.md` files, images) and for 6 panels (Changes, Browser, Files, Terminal, Side chat, Artifacts), with 2 panes at most and an Expand that covers the chat.
  - **Workflows** (the canvas editor and the YAML) and **Settings** (agent defaults, permission questions, triggers, cost, slots, file locations).
- Not yet: `workflow` steps (the parser takes the kind, but a task that reaches one stops and says so); a scheduled morning brief, the assistant on screens other than its own; a record on the task for the files it changes and the commands it runs itself (an event on the task, or a run row of its own kind, so its work shows next to the agents'); GitHub and webhook triggers; a step that watches CI and pull request comments; permission questions for Codex (it runs in its own sandbox instead).
