# Writing a workflow

A workflow is a YAML file: a list of steps, and the arrows between them. This page is the reference. For the words Orstra uses, read [concepts.md](concepts.md). For the rules behind the design, read [design.md](design.md).

## Where the files live

Workflows are your config, not repository files. They live in `~/.orstra/workflows/*.yaml`.

On its first run Orstra copies the repository's `workflows/` folder there. After that the folder is yours, and Orstra never writes over it. To keep them somewhere else, set `ORSTRA_WORKFLOWS`.

Edit a file in your editor, or on the **Workflows** screen. The canvas and the YAML edit the same file.

A task keeps a copy of the workflow it started with. An edit to the file changes new tasks only. The task page offers "Use the new version" for a task that still runs.

## The fields of a workflow

| Field | What it does |
|---|---|
| `name` | Required. The name you see in the UI. |
| `description` | 1 or 2 sentences, shown on the Workflows screen. |
| `repo` | The repository each task works in. Each task gets a git worktree on branch `orstra/<task>`. Without a repo, a task gets its own empty git repository to work in. |
| `concurrency` | How many of this workflow's tasks may work at the same time. Default 3. Only agent and gate steps count. |
| `budget_usd` | Stop agent work on a task once its runs cost this much. |
| `start` | The first step. Default: the first step in the file. |
| `triggers` | What starts tasks without you. |
| `steps` | Required. The steps, by id. |
| `layout` | Where each step sits on the canvas. The editor writes this; you do not need it. |

## Step kinds

| Kind | What it does | Outcomes |
|---|---|---|
| `agent` | An agent works on a prompt | `done`, `needs_you`, `cant_do` |
| `gate` | Runs shell commands, such as tests | `pass`, `fail` |
| `human` | Waits for your decision | 1 per choice (`approved`, `changes_requested`, `rejected`, …) |
| `switch` | Picks a branch from the task's data | the matching case, else `default` |
| `action` | Runs 1 named action | `ok`, `error`, `conflict`, `nothing`, `refused` |

An agent or a gate step can also end with `timeout`. An agent step can also end with `over_budget`.

Fields by kind:

| Field | Kind | What it does |
|---|---|---|
| `title` | all | The name on the board and in the Inbox. Default: the step id. |
| `timeout` | agent, gate | Minutes. Default: 120 for an agent, 30 for a gate. |
| `prompt` | agent | Required. The instruction. Templating works here. |
| `agent` | agent | `claude-code` (default) or `codex`. |
| `model` | agent | A model for this step only, such as `opus`. |
| `run` | gate | Required. 1 command, or a list. Each runs in a shell in the worktree. Exit code 0 is a pass. |
| `question` | human | What you are asked. |
| `choices` | human | The buttons. Default: the outcomes in `on:`. |
| `value` | switch | A template. Its result picks the case. |
| `cases` | switch | Outcome to step, like `on:`. |
| `action` | action | `git.merge`, `github.pr` or `git.cleanup`. Another name is a parse error. |
| `with` | action | Input for the action. |

## Arrows and outcomes

Every step ends with exactly 1 outcome. Each arrow is labeled with an outcome. Orstra follows the arrow that matches.

`next:` is a short way to write the arrow for the kind's success outcome: `done` for an agent, `pass` for a gate, `approved` for a human step, `ok` for an action, `default` for a switch.

`on:` writes any outcome to any step. `end` finishes the task.

A backward arrow needs a cap: `{ goto: impl, max: 3 }`. Without a cap a loop could never stop.

The task goes to your Inbox when the outcome has no arrow, when a cap runs out, on a timeout, on `over_budget`, or on `needs_you`. Nothing is ever silently stuck.

## Templating

`{{ ... }}` in a prompt or a switch value reads the task:

| Path | Value |
|---|---|
| `{{ trigger.title }}` | The task's title |
| `{{ trigger.description }}` | Its description |
| `{{ trigger.ref }}` | Its ticket, such as `HUB-416` |
| `{{ trigger.id }}` | The ticket, or the task id when there is none |
| `{{ task.id }}` | The task id |
| `{{ steps.impl.output }}` | What the `impl` step said it did |
| `{{ steps.impl.outcome }}` | How `impl` ended |
| `{{ steps.impl.progress.did }}` | A field of its progress entry (`did`, `decided`, `left`, `avoid`) |

A path that does not exist becomes an empty string.

## Triggers

Orstra checks every trigger each `ORSTRA_TRIGGER_INTERVAL_S` seconds (60 by default). It reads the files on each check, so a trigger you add works on the next check, with no restart.

**`linear`** starts 1 task per open Linear issue with a label. It needs `LINEAR_API_KEY` in the daemon's environment.

```yaml
triggers:
  - linear:
      label: agent-ready     # required
      team: HUB              # optional, the team key
      state: Todo            # optional; the default is every issue that is not completed or canceled
      repo: ~/workspace/app  # optional, the repository for these tasks
      comment: true          # default true: each progress entry goes back as a comment on the issue
```

**`schedule`** starts 1 task each time a cron expression matches, or every interval. This is a declarative schedule: only an edit of the workflow file changes it.

```yaml
triggers:
  - schedule:
      cron: "0 9 * * 1-5"          # 5 fields: minute hour day-of-month month day-of-week
      timezone: Europe/London      # optional IANA name; the default is UTC
      title: "Triage {{ date }}"   # {{ date }} becomes the due date in the timezone, such as 2026-11-25
      description: Look at what came in.
      workspace: app               # optional, the workspace by name
  - schedule:
      every: 1d                    # instead of cron: "30m", "6h", "1d", or a number of minutes
      title: "Dogfood Orstra"
      repo: ~/workspace/app
```

A schedule has `cron` or `every`, not both. An interval counts from when Orstra first saw the trigger.

The input of a scheduled task is its title and description. Steps read them as `{{ trigger.title }}` and `{{ trigger.description }}`, as for any task. In the title and the description of a schedule, these placeholders are filled when the task starts:

| Placeholder | Becomes |
|---|---|
| `{{ date }}` | The date it is due, such as 2026-11-25, in its timezone |
| `{{ time }}` | The time it is due, such as 09:00, in its timezone |
| `{{ last_run }}` | The date the schedule last started a task, or `never` |

A step prompt in a task that a schedule started can also read `{{ trigger.schedule.date }}`, `.time`, `.timezone`, `.last_run`, `.due` (the due time in UTC, ISO 8601) and `.id`. In any other task they are empty.

```yaml
prompt: |
  {{ trigger.description }}
  Look only at what changed since {{ trigger.schedule.last_run }}.
```

You can also make imperative schedules on the Triggers page, or ask the chief of staff. Orstra keeps them in its database, and you can change, turn off, or delete them there. The Triggers page lists both kinds.

A schedule starts at most 1 task per due time, also across a restart. If due times passed while Orstra was off, it starts 1 task when it is back, and then waits for the next due time.

## Actions

| Action | What it does | Outcomes |
|---|---|---|
| `git.merge` | Merges the task's branch into the branch its repository has checked out. Local only. It never pushes and never forces. It refuses when the main checkout has uncommitted changes, and undoes a conflicted merge. | `ok`, `conflict`, `error` |
| `github.pr` | Pushes the task's branch and opens a draft pull request with `gh`. If 1 is already open for the branch, it pushes the new commits to it. Needs the GitHub CLI, signed in. | `ok`, `nothing`, `error` |
| `git.cleanup` | Removes the task's worktree, and the branch when the checked-out branch already holds its commits. Put it last: steps after it have no worktree. | `ok`, `refused` |

`with:` for `github.pr`: `title`, `body`, `draft` (default true), `base` (default: the branch the repository has checked out), `remote` (default `origin`).

`with:` for `git.cleanup`: `force: true` also throws away uncommitted work.

## How agent steps run

Each run is a fresh `claude -p` session (stream-json) in the task's worktree, with a known session id. The prompt holds the step's text, the task, the progress entries of the earlier runs, and any notes you left. The agent ends with a `## Progress` block and an `OUTCOME:` line. Open the same session in your terminal with `claude --resume <id>`, from the command the UI shows.

If an agent ends a turn with no `OUTCOME:` line, Orstra asks once. If it is still absent, the task comes to you.

A Claude Code tool call that the permission mode does not allow comes to your Inbox as a question: Allow once, Allow for this task, or Refuse with a reason the agent reads. Turn this off in Settings.

Each run records its cost and its tokens. Codex reports tokens but no cost, so `budget_usd` does not count Codex runs.

A step's agent can publish a **Claude artifact**, a page on your claude.ai account, and prints the link in its message. Turn it off in Settings → Agents, or with `ORSTRA_CLAUDE_ARTIFACT=0`. See [concepts.md](concepts.md#claude-artifact) for the limits.

Codex steps run `codex exec --json` in the worktree, 1 process per turn, in a `workspace-write` sandbox.

## Settings

Orstra reads these from the daemon's environment.

| Variable | Default | What it sets |
|---|---|---|
| `ORSTRA_HOME` | `~/.orstra` | The database, the workflows, the worktrees |
| `ORSTRA_WORKFLOWS` | `$ORSTRA_HOME/workflows` | The workflow folder |
| `ORSTRA_PORT` | `4317` | The daemon's port |
| `ORSTRA_SLOTS` | `4` | Agent and gate runs that may work at the same time on this machine |
| `ORSTRA_AGENT_TIMEOUT_MIN` | `120` | The timeout of an agent step that sets none |
| `ORSTRA_GATE_TIMEOUT_MIN` | `30` | The timeout of a gate step that sets none |
| `ORSTRA_CLAUDE_PERMISSION` | `acceptEdits` | Claude Code's permission mode for agent steps |
| `ORSTRA_CLAUDE_TOOLS` | `Bash Read Edit Write Glob Grep` | The tools an agent step may use |
| `ORSTRA_CLAUDE_ARTIFACT` | `1` | Whether a step's agent may publish a Claude artifact |
| `ORSTRA_CODEX_SANDBOX` | `workspace-write` | The sandbox for Codex steps |
| `ORSTRA_COS_MODEL` | Claude Code's own default | The model for the chief of staff |
| `LINEAR_API_KEY` | none | Needed by Linear triggers |
| `ORSTRA_TRIGGER_INTERVAL_S` | `60` | Seconds between trigger checks |
| `ORSTRA_UI_PORTS` | `5317` | Other UI ports the API accepts |
| `ORSTRA_ALLOWED_HOSTS` | none | More host names the API accepts |

Agent defaults (model, effort, permission mode, permission questions, artifacts) also live in Settings → Agents, which writes `~/.orstra/agents.json`.

## A longer example

This is `workflows/linear-to-pr.yaml`, which Orstra ships. An agent implements a Linear ticket, the tests run, you review, and Orstra opens a draft pull request.

```yaml
name: Linear ticket to PR
description: An agent implements a Linear ticket, the tests run, you review, and Orstra opens a draft pull request.

# Starts one task per open issue with this label. Needs LINEAR_API_KEY in the daemon's environment.
# Each progress entry goes back to the issue as a comment. Remove this block to start tasks by hand only.
triggers:
  - linear:
      label: agent-ready

concurrency: 2
budget_usd: 10

steps:
  impl:
    title: Implement
    use: agent
    timeout: 90
    prompt: |
      Implement the ticket "{{ trigger.title }}" ({{ trigger.ref }}).
      {{ trigger.description }}
      Commit your work on this branch with a clear message. If a human left feedback, address it first.
    next: test

  test:
    title: Tests
    use: gate
    run: [npm test]
    on:
      pass: review
      fail: { goto: impl, max: 2 }

  review:
    title: Review
    use: human
    question: Is the change ready for a pull request?
    on:
      approved: pr
      changes_requested: { goto: impl, max: 3 }
      rejected: end

  # Pushes the task branch and opens a draft pull request with gh. Nothing is merged.
  pr:
    title: Pull request
    use: action
    action: github.pr
    next: end
```

To use it, set `repo:` at the top of the file, or pass `--repo` when you start a task by hand.
