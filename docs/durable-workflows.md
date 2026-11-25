# Durable workflows with a human in the loop

Status: design note, for review. No product code changes with it.

Orstra already keeps the workflow state durable. Tasks, runs, outcomes, decisions and events are rows in SQLite, and a `human` step can wait for days at no cost. Execution is not durable. An agent session is a child process of the daemon. When the daemon restarts, `recover()` in `apps/daemon/src/runner.ts` marks the agent run `waiting` with `wait_reason: 'paused'`, stops a stray process, and says "Orstra restarted mid-run". A gate or an action run fails with outcome `interrupted`. Then the task stays still until you message it or retry it.

This note says how to close that gap. It compares each part with trigger.dev v4. I did not read the trigger.dev docs for this note (the fetch was stopped), so the trigger.dev facts below come from memory. The 2 that matter most are marked "(check)".

## 1. Orstra next to trigger.dev

| trigger.dev v4 | Orstra today | Proposal |
| --- | --- | --- |
| Checkpoint and resume of the process | Session JSONL on disk, `--resume` on your next message | Auto resume after a restart (sections 2, 3) |
| Retries with backoff (`maxAttempts`, `factor`, min and max delay) | None. A crash goes to the Inbox | A `retry:` policy per step, apart from the arrows (section 4) |
| Queues with `concurrencyLimit` and priority | Machine slots, plus `concurrency:` per workflow | Add a limit per workspace, and priority (section 5) |
| `wait.for`, `wait.until` | None | A `wait` step (section 6) |
| `wait.forToken`, completed by a POST to `token.url` | `human` step, completed by the UI | Tokens. A human step is a token that the UI completes (section 6) |
| `triggerAndWait`, `batchTriggerAndWait` | `workflow` step kind parses, but does not run | Child tasks, fan out, wait for all (section 7) |
| Idempotency keys with a TTL | `source` plus `taskBySource()` for Linear only | `idempotency_key` on the task (section 8) |
| A run is locked to its version | Done. `tasks.workflow_yaml` keeps the copy the task started with | Keep as it is |

trigger.dev releases the concurrency slot of a run while it waits (check). Orstra does the same now. A `human` step or a paused agent takes no slot.

## 2. What "durable" means for each step kind

**Agent step.** The checkpoint is the Claude Code session file plus the git worktree. Both are on disk. `claude -p --resume <session id>` continues the same conversation. Codex has its own session id, which `onSessionId` already stores.

These things are lost when the process dies mid turn:

- The model reply that was in progress. The tokens are paid and the text is gone.
- A tool call that was in progress, for example a long `npm test` in Bash. Its side effects can be partial.
- Background processes that the agent started, such as a dev server.
- Permission questions. They live in memory (`Runner.permissions`), so a restart loses them.

These things survive: every file edit already on disk, every commit, and every completed message in the session file.

The resumed agent does not know that it was cut off. Orstra must tell it. On resume, Orstra sends a first message like this:

> --- Orstra --- The Orstra daemon restarted at 14:02 while you worked. Your last turn stopped before it finished. Your last tool call was `Bash: npm test`, and its result is lost. It left 1 commit on the branch. Run `git status` before you continue, because a step may be half done. Then continue the step and end with the OUTCOME line.

Orstra has the facts for that message. The `events` table holds the last `tool` event with no `tool_result`, and `recover()` already counts the commits between `head_before` and `HEAD`. I must test 1 thing: what Claude Code does with a session file that ends on a `tool_use` with no result. I expect it to repair the gap on resume. If it does not, Orstra must start a fresh session with the progress text instead.

**Gate.** Rerun it from the first command. A gate has no checkpoint, and most gates (`npm test`, `npm run typecheck`) are safe to run twice. A rerun is unsafe when a command changes something outside the worktree:

- It deploys, publishes a package, or pushes.
- It runs a database migration on a shared database.
- It sends a message or calls a paid API.

For those, the author sets `rerun: false` on the step, and a restart sends the task to the Inbox as it does today. There is 1 more problem. `runShell()` uses `shell: true` with no process group, so a stop kills the shell but not its children. A rerun can then fail because an old child still holds a port. Spawn each gate in its own process group and kill the group.

**Human step.** Durable already. The run row is `waiting` and nothing runs.

**Action.** An action must give the same result when it runs twice. Actions run with `execFileSync` inside the daemon, so a restart can cut one off only when the daemon crashes or is killed during the call. I read the 3 actions:

- `git.merge`, second time: `rev-list target..HEAD` is 0, so it returns `nothing`, and the action maps that to `ok`. Safe. If the crash came during a merge with conflicts, the main checkout keeps `MERGE_HEAD`. The second run returns `error` ("a merge is already in progress") and the task goes to the Inbox. That is correct. It does not hide the problem.
- `github.pr`, second time: the push is a no-op, `gh pr view` finds the open pull request, and the action returns `exists`, which maps to `ok`. Safe. 1 gap: if somebody closed that pull request without a merge, the filter on `state == "OPEN"` misses it, and the action opens a second one. Fix it with a look at `tasks.pr_url` first.
- `git.cleanup`, second time: the worktree is gone, so it returns `removed`. Safe.

So all 3 actions can rerun after a restart with no question. A future action must say if it is safe to rerun. Put that flag in the `ACTIONS` table, not in the YAML.

## 3. Process survival: detach, or resume

**Option A: agent processes outlive the daemon.** Spawn the agent detached. Write its stdout to a file under `~/.orstra/runs/<run id>.jsonl`. Give it a named pipe (FIFO) as stdin. On start, the daemon finds the process, reads the log file from its last offset, and opens the FIFO again.

- For: nothing is lost in a restart.
- Against: the permission tool (`perm-mcp.ts`) talks to the daemon over HTTP, so a question in the restart window fails. Chat and interrupt need the FIFO to work across 2 daemons. Codex starts 1 process per turn, so it gets nothing. Orphan processes become normal, so every stop path and every "2 agents in 1 worktree" guard must change. A bug here costs you work.

**Option B: the daemon resumes sessions after a restart.** On start, `recover()` puts each cut agent run back in the queue as a resume. When a slot is free, Orstra opens the session with `--resume` and sends the message from section 2.

- For: small. It uses code that works today (`deliver()` already resumes a session). It works the same for Claude Code and Codex. It also covers a crash of the machine, which Option A does not.
- Against: the turn in progress is lost. That is up to 1 model reply and 1 tool call.

**Pick: Option B.** The daemon is restarted on purpose more often than it crashes. For a planned restart, `shutdown()` already closes stdin, and the agent stops at the end of its current action. So the planned case loses almost nothing. Raise the grace time of `shutdown()` from 5 s to about 60 s, so the action can end. Keep Option A as a later step, only if lost turns still hurt after B ships.

Rules for the resume:

- Wait for the stray process to stop before the resume. Today `recover()` calls `sweep()` and does not wait for it.
- Count resumes for each run. After 3 resumes in 10 minutes, stop and send the task to the Inbox. This stops a loop where the agent itself makes the daemon crash.
- A resume takes a slot, and it goes before new work in the queue.

## 4. Retries, apart from the outcome arrows

An arrow such as `fail: { goto: work, max: 2 }` is part of the workflow logic. The author wrote it, and the outcome came from the work. A retry is for a fault in the system, where the work did not get an answer. Keep them apart:

```yaml
work:
  use: agent
  retry: { max: 2, delay: 1m, factor: 4, maxDelay: 30m }   # default for agent steps
```

Orstra retries these faults and no others:

| Fault | Where Orstra sees it today |
| --- | --- |
| The agent process exits with no outcome | `onClosed()`, "Claude Code exited before finishing the step" |
| An API error, overload, or rate limit | `onTurn()` with `t.isError` |
| A usage limit with a reset time | `isError` text. Wait until the reset time, not the backoff |
| A timeout | `onTimeout()`. Off by default, because a timeout usually means the agent is stuck. `retry: { onTimeout: true }` turns it on |

Orstra never retries the outcomes that the work gives: `fail`, `cant_do` from an OUTCOME line, `needs_you`, `over_budget`, `setup_failed`, a `conflict` from an action.

How it works: the fault gives an internal outcome such as `crashed`. Before `finish()` calls `route()`, it reads the retry policy. If retries are left, it queues a new run with `attempt + 1` and a new column `not_before`. `pump()` skips a run until `not_before` has passed. The task card says "Retry 1 of 2 at 14:20". An agent retry resumes the same session with a note about the fault. After the retries end, the fault goes to the router as today, so an arrow or the Inbox handles it.

A restart is not a fault of the step. A resume (section 3) does not count as a retry.

## 5. Queues: limits and priority

Today `pump()` checks 2 limits: the machine slots (`SLOTS`) and the workflow `concurrency` (default 3). Gaps:

- A chat message that waits for a slot (`held`) skips the workflow limit.
- There is no limit per workspace. 3 workflows on 1 repo can run 9 agents and 9 `npm install` commands at the same time.
- The order is the order of the rows. There is no priority.

Proposal:

- Add `concurrency` to the workspace, set on the Workspaces page. A run starts only when all 3 limits allow it: machine, workspace, workflow.
- Apply the limits to held messages too.
- Add `priority` to the task, a number of seconds, as trigger.dev does: a task with priority 600 goes as if it was queued 10 minutes earlier (check). Old work still moves, so nothing waits forever. Triggers, the CLI and the chief of staff can set it.
- The order in the queue: held chat messages, then resumes after a restart, then runs by `created_at - priority`.

Named queues that many workflows share are not in this note. Section 11 asks if you want them.

## 6. Waits and tokens

**Timer wait.** A new step kind:

```yaml
cool_off:
  use: wait
  for: 2h                     # or: until: "2026-12-01T09:00:00+01:00"
  next: check
```

The run becomes `waiting` with `wait_reason: 'timer'` and a new column `wake_at`. It takes no slot. 1 loop in the daemon fires due times. The schedule task (t-mwvo9a) builds that loop for schedules now. Waits must use the same loop, with 1 query for schedules due and 1 for runs due. Because `wake_at` is in SQLite, a wait survives a restart.

1 rule differs from schedules. t-mwvo9a skips a schedule time that passed while the daemon was off, as trigger.dev does. A wait that passed while the daemon was off fires at once on start. A wait is part of 1 run that somebody wants to continue. A missed schedule time is a run that never started.

**Token wait.** The same step kind with a token:

```yaml
ci_green:
  use: wait
  token: { timeout: 3d }
  on: { completed: merge, timeout: work }
```

Orstra makes a row in a new `tokens` table: an id that nobody can guess, the run, the status, `expires_at`, and the result. The step shows its URL:

```
POST http://127.0.0.1:4317/api/tokens/<token id>/complete
{ "outcome": "completed", "data": { ... } }
```

The POST finishes the run. The outcome in the body picks the arrow, and `data` becomes `{{ steps.ci_green.output }}`. When `expires_at` passes, the loop finishes the run with `timeout`. The token id is the secret. The daemon listens on localhost only, so a system outside this machine needs a tunnel (section 11).

**A human step is a token that the UI completes.** In this proposal, each `human` step makes a token too. `decide()` becomes "complete this run's token with outcome = choice and data = comment". The human step adds only the parts for a person: the question, the list of choices, the Inbox entry, and the rule in `decide()` that refuses while an agent works. That rule applies to every token. Then you can answer a decision from the UI, from the chief of staff, from a Linear comment, or with `curl`, and all of them use 1 code path.

## 7. Child workflows

The `workflow` step kind is in `STEP_KINDS`, and its `SUCCESS_OUTCOME` is `started`. It does not run. `execute()` reaches "Step type "workflow" isn't built yet." and finishes the run with `cant_do`.

Proposal:

```yaml
file:
  use: workflow
  workflow: orstra-build
  for_each: "{{ steps.pick.items }}"      # optional: fan out
  with: { title: "{{ item.title }}", description: "{{ item.body }}" }
  wait: true                               # false = start and move on
  on: { done: end, partial: pick }
```

- `wait: false` starts the child task and finishes with `started`, as the schema says now.
- `wait: true` makes the run `waiting` with `wait_reason: 'children'`. It takes no slot, so a parent cannot block its own children. When the last child task ends, the run finishes with `done` (all done), `partial` (some done), or `failed` (none done). `{{ steps.file.children }}` lists each child with its status, branch and `pr_url`.
- Each child task gets `parent_task_id` and `parent_run_id`, and the idempotency key `<parent run id>:<index>`. A resume or a retry of the parent then finds the children it already started, and never starts them twice.
- The children go through the normal queue, so a fan out of 10 respects the slots and limits.
- `for_each` needs a list. Today the progress note is free text. The list can come from a JSON file in `.orstra/artifacts/`, or from the lines of a human comment.

The dogfood workflow is the first user. Today its `file` step is an agent that runs `bin/orstra run orstra-build` 1 time for each finding. A fan out step does the same with no agent, no cost, and no risk of a duplicate.

## 8. Idempotency keys on task start

Add `tasks.idempotency_key`, with a unique index on `(workflow_path, idempotency_key)`. `startTask()`, the API, and the CLI (`bin/orstra run <wf> --key <k>`) accept a key. If a task with that key exists, Orstra returns that task and starts nothing. The key stays after the task ends or goes to the archive, as `source` does today for Linear. trigger.dev has a TTL on keys (30 days by default, I believe). Orstra can add `keyTtl` later if somebody needs it.

Users of the key:

- **Linear trigger:** key `linear:<issue id>`. It replaces the check in `taskBySource()`.
- **Schedules (t-mwvo9a):** key `schedule:<schedule id>:<due time in ISO>`. This gives "at most 1 task for each due time, also across a restart" from the database, not from timing. The schedule object keeps its own `deduplicationKey`, which stops a second schedule. The task key stops a second task. They do 2 different jobs.
- **Child tasks:** key `<parent run id>:<index>` (section 7).
- **Dogfood loop:** until fan out ships, give agents the variable `ORSTRA_TASK_ID`. The `file` prompt then runs `bin/orstra run orstra-build --key "$ORSTRA_TASK_ID:<finding number>"`. A resumed or retried `file` step then cannot file a finding twice.

## 9. Build or adopt

The unit of work is a CLI process with its session on disk, in a git worktree on this machine. No engine can checkpoint that process. trigger.dev checkpoints its own container, not a `claude` process on the host with files in `~/.claude`. With every engine, the durability of an agent step still comes from `--resume`, and Orstra must write that code.

| Engine | What it needs | Fit |
| --- | --- | --- |
| trigger.dev self-hosted | Docker, Postgres, Redis, object storage | Poor. Tasks run in its containers, but the agent must run on the host with your repos and your Claude login |
| Temporal | A server and a database. Deterministic workflow code | Poor. Orstra would write a YAML interpreter on top, and a long activity still dies with its worker |
| Inngest, Restate | 1 binary each | Medium. Good timers and events, but a second state store, and the agent step is still 1 long call |
| DBOS | A library. The state goes in your database | Closest idea, but its TypeScript library uses Postgres (I believe) |

What an engine would give is timers, retries, queues and signals. On 1 machine with 1 user and SQLite, each of those is a few columns and 1 loop. Orstra already has the hard part: a run state machine in SQLite, a projection that rebuilds after a restart, and a lock to 1 open run for each task. An engine adds a second source of truth that must agree with SQLite, and it makes Orstra hard to install.

**Recommendation: build it into Orstra, on SQLite.** Use trigger.dev's names and semantics (retry fields, `wait.for` and `wait.until`, tokens with a URL, `triggerAndWait`, idempotency keys, priority in seconds), so the model is familiar. This is the DBOS idea: the database is the engine.

## 10. The order to build it in

Each task ships on its own and helps on its own.

1. **Auto resume after a restart.** `recover()` queues each cut agent run as a resume, waits for the stray process to stop, resumes the session, and sends the "you were cut off" message. Add the limit of 3 resumes in 10 minutes. Raise the grace time of `shutdown()`. Rerun gates and the 3 actions (with `rerun: false` for gates and the process group fix). Test first how Claude Code resumes a session that ends on a tool call. This fixes the daily pain, and nothing else must come before it.
2. **Retries with backoff.** The `retry:` policy, `not_before`, and the wait for the reset time of a usage limit.
3. **Idempotency keys.** The column, the API and CLI flag, `ORSTRA_TASK_ID`, Linear on the key, and the dogfood prompt. Merge with t-mwvo9a so schedules pass their key.
4. **Queues.** Workspace `concurrency`, limits on held messages, task `priority`.
5. **Timer waits.** The `wait` step with `for` and `until`, on the due loop from t-mwvo9a.
6. **Tokens.** The `tokens` table, the complete URL, and the `human` step on tokens.
7. **Child workflows.** `use: workflow` with `wait`, then `for_each`. Move the dogfood `file` step to it.
8. **Later, if needed:** detached processes (Option A), persistent permission questions, named shared queues, a TTL on keys.

## 11. Questions for you

1. **Auto resume by default.** Should every cut agent run resume on its own after a restart, or should a workflow turn it on? I propose on for all.
2. **Retry of an agent.** Should a retry resume the same session (cheap, keeps the context, can keep a bad state), or start a fresh one with the progress text? I propose: resume first, and fresh for the last try.
3. **Retry on timeout.** Off by default, as I propose, or on?
4. **Outside systems.** Should a system outside this machine (GitHub, CI) complete tokens? That needs a tunnel or a relay, and auth beyond the token id. Or is localhost enough for now?
5. **Shared queues.** Do you need a limit that many workflows share, for example "1 agent on the orstra repo at a time", or is the workspace limit enough?
6. **Children and branches.** Should a child task branch from the base branch of the workspace, or from the parent's branch, so it builds on the parent's work?
7. **Schedules.** May I ask t-mwvo9a to pass `schedule:<id>:<due time>` as the task key, and to expose its due loop so waits can use it?
