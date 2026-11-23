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

## How agent steps run

Each run is a fresh `claude -p` session (stream-json) in the task's worktree, with a known session id. The prompt includes the task's progress entries from earlier runs and any notes you left. The agent ends with a `## Progress` block and an `OUTCOME:` line. Open any session in Claude Code with the command shown in the UI (`claude --resume <id>`).

Settings via environment variables: `ORSTRA_HOME` (default `~/.orstra`), `ORSTRA_WORKFLOWS` (default `$ORSTRA_HOME/workflows`), `ORSTRA_PORT` (4317), `ORSTRA_SLOTS` (4), `ORSTRA_CLAUDE_PERMISSION` (`acceptEdits`), `ORSTRA_CLAUDE_TOOLS` (`Bash Read Edit Write Glob Grep`).

## Develop

```sh
npx vitest run      # engine + runner tests
npm run typecheck
```
