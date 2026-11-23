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
- Auto-merging. A human merges; Orstra opens draft PRs.
- Its own coding agent. Orstra orchestrates existing CLIs.

## Concepts

Task, workflow, step, trigger, run, session, outcome, progress entry, note and decision are defined in [concepts.md](concepts.md), along with which screen is each one's home. Use those words exactly.

## The rules we settled

1. **The workflow is a state machine with capped loops, not a DAG.** Every step ends with exactly one outcome; each arrow out of a step is labeled with an outcome; Orstra follows the matching arrow. Backward arrows (retries, "changes requested") must declare a cap. Cap reached, no matching arrow, timeout, or `needs_you` → the task goes to your Inbox. Nothing is ever silently stuck.
2. **The task persists; sessions don't.** Every run of a step is a fresh session, retries included. Continuity comes from the task's progress entries, the worktree and git. Workflows also chain into each other through triggers and `workflow` steps.
3. **Hand-offs live in the task's progress, not in files.** Each run ends by writing a progress entry (Did / Decided / Left / Avoid). The next session starts from those entries. Entries are mirrored to the ticket's source (e.g. a Linear comment), summaries only.
4. **Human steps are decisions with consequences.** A human step shows the artifact being decided (e.g. the spec), the agent's assumptions and open questions, and what each choice does. Each choice is an outgoing arrow.
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
- **API:** REST for tasks, runs, sessions, decisions, messages; SSE `/api/events` for live updates.

## What is built

- Engine: parse a workflow, start a task by hand (CLI or UI), run agent / gate / human / switch steps, route outcomes with capped loops, record runs, sessions, events and progress. You can message a running agent, stop its turn, and reopen an ended session.
- Chief of staff: a long-running Claude Code session with only Orstra's tools (an MCP server, `apps/daemon/src/cos-mcp.ts`, that forwards to the daemon). The daemon enforces what needs your OK; gated actions become plans. Watches wake it when a task reaches a state.
- UI: the chief of staff page, then four places (see [concepts.md](concepts.md)):
  - **Inbox**: tasks that need you, grouped by decision, agent waiting, stuck. Rows only open the task.
  - **Tasks**: board (columns are one workflow's steps) and list (grouped by status).
  - **Task page**, two views. **Overview**: where the task is, what happens next, the decision if one is waiting, every run with its progress note, and notes for upcoming steps. **Chat**: the task's sessions, the conversation with the selected one, and the worktree panel (branch, changed files with diffs, checks, commits).
  - **Workflows** (read-only steps and YAML) and **Settings** (read-only: agents found, slots, file locations).
- Not yet: a scheduled morning brief, the chief of staff on screens other than its own; triggers (Linear polling), the Codex runner, action steps (so no PR is opened yet), the workflow canvas editor, editable settings, mirroring progress to the ticket.
