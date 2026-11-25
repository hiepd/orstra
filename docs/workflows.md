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
| `triggers` | The old form. Orstra moves it into trigger files: see [Triggers](#triggers). |
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
| `retry` | agent, gate | What to do after a fault: a crash, an API error, or a usage limit. `{ max, delay, factor, maxDelay, onTimeout }`. Default for an agent: 2 retries, after 1 min and then 4 min, in the same session. A gate: none. `retry: false` = none. A usage limit with a reset time waits until that time. A timeout is retried only with `onTimeout: true`. A fault is never an outcome: the arrows see `cant_do` or `timeout` only when the retries run out. |
| `rerun` | gate, action | `false` = a restart does not run this step again, and the task goes to your Inbox. Default: a gate runs again, and the 3 actions run again because each one gives the same result twice. Set it on a command that changes something outside the worktree, such as a deploy. |
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
| `{{ trigger.prompt }}` | The prompt the trigger gave the task, or empty. You rarely need it: every agent step gets it anyway (see below) |
| `{{ task.id }}` | The task id |
| `{{ steps.impl.output }}` | What the `impl` step said it did |
| `{{ steps.impl.outcome }}` | How `impl` ended |
| `{{ steps.impl.progress.did }}` | A field of its progress entry (`did`, `decided`, `left`, `avoid`) |

A path that does not exist becomes an empty string.

## Triggers

A workflow is a recipe, and a trigger starts it. A workflow does not list its triggers. Each trigger names the workflow it starts. 1 trigger starts 1 workflow, and 1 workflow can have many triggers.

There are 2 kinds:

- **Declarative**: a YAML file in `~/.orstra/triggers` (`ORSTRA_TRIGGERS` changes the folder). The file name is the trigger's id. Only an edit of the file changes it. Keep the folder in git if you like.
- **Imperative**: a schedule made on the Triggers page, by the API, or by the chief of staff. Orstra keeps it in its database. You change it, turn it off, or delete it there.

The Triggers page lists both kinds. Orstra reads the trigger folder on each check (every `ORSTRA_TRIGGER_INTERVAL_S` seconds, 60 by default), so a file you add works on the next check, with no restart. A file that is wrong shows its error on the Triggers page.

**A schedule** starts 1 task each time a cron expression matches, or every interval.

```yaml
# ~/.orstra/triggers/morning-triage.yaml
workflow: triage                   # the workflow file without .yaml, or its name
schedule:
  cron: "0 9 * * 1-5"              # 5 fields: minute hour day-of-month month day-of-week
  timezone: Europe/London          # optional IANA name; the default is UTC
title: "Triage {{ date }}"         # the task title
prompt: |                          # what the agents of each task are told to do
  Triage what came in since {{ last_run }}.
description: The morning triage.   # optional, shown on the task
workspace: app                     # optional, the workspace by name
```

`schedule:` has `cron` or `every`, not both. `every: 1d` (or `30m`, `6h`, a number of minutes) counts from when Orstra first saw the trigger. `repo:` instead of `workspace:` gives a bare repository path.

**A Linear trigger** starts 1 task per open Linear issue with a label. It needs `LINEAR_API_KEY` in the daemon's environment. The task takes its title and description from the issue.

```yaml
# ~/.orstra/triggers/agent-ready.yaml
workflow: linear-to-pr
linear:
  label: agent-ready     # required
  team: HUB              # optional, the team key
  state: Todo            # optional; the default is every issue that is not completed or canceled
  comment: true          # default true: each progress entry goes back as a comment on the issue
workspace: app           # optional
```

**What a trigger gives the task.** The trigger fills the task, and the workflow reads only the task:

- `title`: the task's title.
- `prompt`: what the agents of the task are told to do. Every agent step gets it after its own prompt, under "Prompt:". The workflow does not name it, so 1 workflow serves many triggers, and the same workflow works for tasks you start by hand.
- `description`: what the task is about, shown on the task, as in the New task form. Agents see it as the task's description.

In the title, the prompt and the description of a schedule, these placeholders are filled when the task starts:

| Placeholder | Becomes |
|---|---|
| `{{ date }}` | The date it is due, such as 2026-11-25, in its timezone |
| `{{ time }}` | The time it is due, such as 09:00, in its timezone |
| `{{ last_run }}` | The date the schedule last started a task, or `never` |

A schedule starts at most 1 task per due time, also across a restart. If due times passed while Orstra was off, it starts 1 task when it is back, and then waits for the next due time.

**A `triggers:` list in a workflow file** is the old form. On its next check, Orstra moves each entry into its own trigger file, named `<workflow>-<kind>.yaml` (with `-1`, `-2` when there are more). It then removes the list from the workflow file and keeps a copy of the file as `<file>.bak-YYYYMMDD`. A schedule keeps its last run and its next run. A workflow file that does not parse is left alone.

## Starting a task once

A start can carry an idempotency key. A second start with the same key and the same workflow returns the first task and starts nothing, also after that task ended or went to the archive.

```sh
bin/orstra run orstra-build --title "Fix the Inbox count" --key "$ORSTRA_TASK_ID:2"
```

The API takes `idempotencyKey` in the body of `POST /api/tasks`, and answers `200` with `reused: true` when the key matched. A Linear trigger uses the key `linear:<issue id>`. A child task uses `<parent run id>:<index>`.

Every agent and gate gets 2 variables for this: `ORSTRA_TASK_ID`, the id of its task, and `ORSTRA_BASE`, the commit the task started from. An agent that starts tasks builds its key from `ORSTRA_TASK_ID`, so a retry or a restart of its step does not start the same task twice.

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
