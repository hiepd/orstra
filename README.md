# Orstra

A local software factory. Coding agents (Claude Code today, Codex next) run your workflows on your machine; you decide and steer. See [docs/design.md](docs/design.md) for the concepts and the rules behind them.

## Run it

```sh
npm install
bin/orstra serve            # daemon + API on http://localhost:4317 (serves the built UI)
npm run dev --workspace @orstra/web   # UI with hot reload on http://localhost:5317
```

Start a task:

```sh
bin/orstra run hello --title "the Orstra team"
bin/orstra run linear-to-pr --title "Empty state on Trending" --ref HUB-416 --repo ~/workspace/your-repo
bin/orstra tasks
bin/orstra sessions
```

Or use **New task** in the UI.

## Workflows

YAML files in `~/.orstra/workflows/` (user config; override the folder with `ORSTRA_WORKFLOWS`). Steps are `agent`, `gate`, `human`, `switch`, `action`. Every step ends with an outcome; arrows (`next:` / `on:`) say where each outcome goes; loops need a cap (`{ goto: impl, max: 3 }`). Anything unmatched goes to your Inbox.

A task keeps a copy of the workflow it started with, so an edit to the file changes new tasks only. The task page offers "Use the new version" for a task that is running.

```yaml
name: Hello Orstra
steps:
  write:
    use: agent
    prompt: Create hello.txt with a greeting for "{{ trigger.title }}".
    next: check
  check:
    use: gate
    run: [test -s hello.txt]
    on:
      pass: approve
      fail: { goto: write, max: 2 }
  approve:
    use: human
    question: Is this greeting good?
    on:
      approved: end
      changes_requested: { goto: write, max: 3 }
      rejected: end
```

More fields:

```yaml
name: Linear ticket to PR
repo: ~/workspace/your-repo
concurrency: 2            # at most 2 tasks of this workflow work at the same time
budget_usd: 5             # stop agent work on a task once it cost $5
triggers:
  - linear: { label: agent-ready, team: HUB }   # needs LINEAR_API_KEY; progress goes back as comments
  - schedule: { every: 1d, title: "Triage {{ date }}" }
steps:
  impl:
    use: agent
    agent: codex          # or claude-code (the default)
    timeout: 60           # minutes; then the task goes to your Inbox
    prompt: Implement {{ trigger.title }}.
    next: review
  review:
    use: human
    question: Open a pull request?
    on: { approved: pr }
  pr:
    use: action
    action: github.pr     # push the branch, open a draft PR with gh
    next: end
```

Actions: `git.merge` (local merge into the checked-out branch, never pushed), `github.pr` (draft pull request with `gh`), `git.cleanup` (remove the worktree, and the branch when merged).

## How agent steps run

Each run is a fresh `claude -p` session (stream-json) in the task's worktree, with a known session id. The prompt includes the task's progress entries from earlier runs and any notes you left. The agent ends with a `## Progress` block and an `OUTCOME:` line. Open any session in Claude Code with the command shown in the UI (`claude --resume <id>`).

If the agent ends a turn with no `OUTCOME:` line, Orstra asks once for it; if it is still absent, the task comes to you. A Claude Code tool call that the permission mode does not allow comes to your Inbox as a question (turn this off in Settings). Each run records its cost and tokens.

A step's agent can also publish a **Claude artifact**: a page on your claude.ai account. It prints the link in its message. Turn it off in Settings → Agents, or with `ORSTRA_CLAUDE_ARTIFACT=0`. See [docs/concepts.md](docs/concepts.md#claude-artifact) for the limits.

Codex steps run `codex exec --json` in the worktree, one process per turn, in a `workspace-write` sandbox.

Settings via environment variables: `ORSTRA_HOME` (default `~/.orstra`), `ORSTRA_WORKFLOWS` (default `$ORSTRA_HOME/workflows`), `ORSTRA_PORT` (4317), `ORSTRA_SLOTS` (4), `ORSTRA_CLAUDE_PERMISSION` (`acceptEdits`), `ORSTRA_CLAUDE_TOOLS` (`Bash Read Edit Write Glob Grep`), `ORSTRA_CLAUDE_ARTIFACT` (`1`), `ORSTRA_COS_MODEL`, `ORSTRA_AGENT_TIMEOUT_MIN` (120), `ORSTRA_GATE_TIMEOUT_MIN` (30), `LINEAR_API_KEY`, `ORSTRA_TRIGGER_INTERVAL_S` (60), `ORSTRA_CODEX_SANDBOX` (`workspace-write`), `ORSTRA_UI_PORTS` (5317, other UI ports the API accepts), `ORSTRA_ALLOWED_HOSTS`.

## Security

The daemon listens on 127.0.0.1 only. It refuses requests from other web sites (Origin check), from DNS-rebinding pages (Host check), and changes without a JSON content type. The chief of staff runs every tool without a prompt, so do not expose the port to a network.

## Develop

```sh
npx vitest run      # engine + runner tests
npm run typecheck
```

CI runs both, and the web build, on each push and pull request (`.github/workflows/ci.yml`).
