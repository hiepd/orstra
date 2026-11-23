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

| Term | Meaning |
|---|---|
| Workflow | A YAML file: triggers plus a graph of steps |
| Task | One thing moving through a workflow (e.g. Linear ticket HUB-416) |
| Step | A node: `agent`, `gate`, `human`, `switch`, `action`, `workflow` |
| Run | One execution of one step for one task. Retries are new runs |
| Session | The agent conversation behind an agent run (Claude Code or Codex) |
| Outcome | How a run ended: `done`, `fail`, `pass`, `approved`, `needs_you`, `timeout`… |
| Progress entry | What a run did, decided, left and wants avoided. Written when it ends |

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
workflows/    Example workflow YAML files
```

- **Store:** SQLite via Node's built-in `node:sqlite` at `~/.orstra/orstra.db` (no native deps).
- **Runner:** a slot-limited scheduler. A task's next step is queued; a free slot picks it up.
- **Agent runs:** `claude -p … --output-format stream-json --session-id <uuid>` in the task's worktree. Stream events become the session's activity. The final message carries the progress entry and an `OUTCOME:` line.
- **Gate runs:** shell commands in the worktree; exit code 0 → `pass`, else `fail`.
- **Worktrees:** when a workflow names a repo, each task gets `git worktree add ~/.orstra/wt/<task> -b orstra/<task>`.
- **API:** REST for tasks, runs, sessions, decisions, messages; SSE `/api/events` for live updates.

## First slice (this milestone)

- Engine: parse a workflow, start a task by hand (CLI or UI), run agent / gate / human / switch steps, route outcomes with capped loops, record runs, sessions, events and progress.
- UI: Sessions (running, queued, ended), Task page (steps, activity, message box, decision for human steps), Inbox (what needs you).
- Not yet: Linear trigger polling, Codex runner, Board, Workflows canvas editor, Triggers/Agents/Settings screens, mirroring progress to Linear, steering a run mid-flight (messages are recorded and handed to the next run).
