# Durable workflows with a human in the loop

Status: built on this branch. Tasks 1 to 8 of section 11 are done, and so are the follow-ups (schedule keys, a callback on human steps, the web UI, a new dogfood workflow), each in its own commit with tests. Section 11 says where the build differs from the plan. The reference for workflow authors is `docs/workflows.md`.

Orstra already keeps the workflow state durable. Tasks, runs, outcomes, decisions and events are rows in SQLite, and a `human` step can wait for days at no cost.

Since `a23bb70` ("Survive a restart by replaying the session log"), agent execution survives a restart too. `recover()` in `apps/daemon/src/runner.ts` stops the old agent process, replays the Claude Code session log after `runs.log_uuid`, and resumes the session with a note. It resumes a run at most 3 times in 10 minutes. A gate runs again from the start. An action still fails with `interrupted` and waits for you. Before this branch, the rest of durable execution was missing: retries, waits, callbacks, child runs and idempotency keys.

This note says how to close that gap. It compares each part with trigger.dev v4. I did not read the trigger.dev docs for this note (the fetch was stopped), so the trigger.dev facts below come from memory. The 2 that matter most are marked "(check)".

## 1. Orstra next to trigger.dev

| trigger.dev v4 | Orstra today | Proposal |
| --- | --- | --- |
| Checkpoint and resume of the process | Done on main. Log replay and auto resume after a restart | Small gaps (sections 2, 3) |
| Retries with backoff (`maxAttempts`, `factor`, min and max delay) | None. A crash goes to the Inbox | A `retry:` policy per step, apart from the arrows (section 4) |
| Queues with `concurrencyLimit` and priority | Machine slots, plus `concurrency:` per workflow | Add a limit per workspace, and priority (section 5) |
| `wait.for`, `wait.until` | None | A `wait` step (section 6) |
| `wait.forToken`, completed by a POST to `token.url` | `human` step, completed by the UI | A `wait` step with `callback:`. The run holds the secret, so no tokens table (section 6) |
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
- Permission questions. They live in memory (`Runner.permissions`). After a restart the resumed agent asks again.

These things survive: every file edit already on disk, every commit, and every completed message in the session file.

The resumed agent does not know that it was cut off, so Orstra tells it. This is done on main: `resumeNote()` names the cut tool call and says "Check what it did before you go on". `sessionLog.ts` reads where the agent stopped, and the commit `a23bb70` checked a `kill -9` during a tool call of 45 s live. 1 small gap is left: the note does not say how many commits the cut turn left. The chat line has that fact, but the agent does not see it. Add it to the note.

**Gate.** Rerun it from the first command. Main does this now. Most gates (`npm test`, `npm run typecheck`) are safe to run twice. A rerun is unsafe when a command changes something outside the worktree:

- It deploys, publishes a package, or pushes.
- It runs a database migration on a shared database.
- It sends a message or calls a paid API.

For those, add `rerun: false` to the step. A restart then sends the task to the Inbox instead. Each gate now runs in its own process group, so a stop ends the shell and every process it started, and a rerun finds no old child that holds a port.

**Human step.** Durable already. The run row is `waiting` and nothing runs.

**Action.** An action must give the same result when it runs twice. Actions run with `execFileSync` inside the daemon, so a restart can cut one off only when the daemon crashes or is killed during the call. I read the 3 actions:

- `git.merge`, second time: `rev-list target..HEAD` is 0, so it returns `nothing`, and the action maps that to `ok`. Safe. If the crash came during a merge with conflicts, the main checkout keeps `MERGE_HEAD`. The second run returns `error` ("a merge is already in progress") and the task goes to the Inbox. That is correct. It does not hide the problem.
- `github.pr`, second time: the push is a no-op, `gh pr view` finds the open pull request, and the action returns `exists`, which maps to `ok`. Safe. 1 gap: if somebody closed that pull request without a merge, the filter on `state == "OPEN"` misses it, and the action opens a second one. Fix it with a look at `tasks.pr_url` first.
- `git.cleanup`, second time: the worktree is gone, so it returns `removed`. Safe.

So all 3 actions can rerun after a restart with no question. This branch does that now. A future action must say if it is safe to rerun. Put that flag in the `ACTIONS` table, not in the YAML.

## 3. Process survival: detach, or resume

**Option A: agent processes outlive the daemon.** Spawn the agent detached. Write its stdout to a file under `~/.orstra/runs/<run id>.jsonl`. Give it a named pipe (FIFO) as stdin. On start, the daemon finds the process, reads the log file from its last offset, and opens the FIFO again.

- For: nothing is lost in a restart.
- Against: the permission tool (`perm-mcp.ts`) talks to the daemon over HTTP, so a question in the restart window fails. Chat and interrupt need the FIFO to work across 2 daemons. Codex starts 1 process per turn, so it gets nothing. Orphan processes become normal, so every stop path and every "2 agents in 1 worktree" guard must change. A bug here costs you work.

**Option B: the daemon resumes sessions after a restart.** On start, `recover()` replays the session log, opens the session with `--resume`, and sends the note from section 2.

- For: small. It uses the session log that Claude Code writes anyway. It works for Codex too (with no replay). It also covers a crash of the machine, which Option A does not.
- Against: the turn in progress is lost. That is up to 1 model reply and 1 tool call.

**Pick: Option B.** Main shipped it in `a23bb70`. Its rules are the ones this note wanted: `recover()` waits for the stray process to stop, and a run resumes at most 3 times in 10 minutes. That limit stops a loop where the agent itself makes the daemon crash.

The commit says most restarts come from `tsx watch` after a merge. `shutdown()` closes stdin, and the agent stops at the end of its current action, but `tsx watch` kills the daemon with SIGKILL after 5 s, and tsx does not let us change that limit. So a planned restart can still cut a turn, and the log replay handles it. Keep Option A as a later step, only if lost turns still hurt.

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
- The order in the queue: held chat messages first, then runs by `created_at - priority`. A resume after a restart opens at once, as it does on main, because its run held a slot before the restart.

Named queues that many workflows share are not in this note. Section 12 asks if you want them.

## 6. Waits and callbacks

**Timer wait.** A new step kind:

```yaml
cool_off:
  use: wait
  for: 2h                     # or: until: "2026-12-01T09:00:00+01:00"
  next: check
```

The run becomes `waiting` with `wait_reason: 'timer'` and a new column `wake_at`. It takes no slot. 1 loop in the daemon fires due times. The schedule task (t-mwvo9a) builds that loop for schedules now. Waits must use the same loop, with 1 query for schedules due and 1 for runs due. Because `wake_at` is in SQLite, a wait survives a restart.

1 rule differs from schedules. t-mwvo9a skips a schedule time that passed while the daemon was off, as trigger.dev does. A wait that passed while the daemon was off fires at once on start. A wait is part of 1 run that somebody wants to continue. A missed schedule time is a run that never started.

**Callback wait.** The same step kind with a callback. This is trigger.dev's `wait.forToken`, built smaller:

```yaml
ci_green:
  use: wait
  callback: { timeout: 3d }
  on: { done: merge, timeout: work }
```

The run gets a random secret (`runs.callback_secret`) and a due time (`runs.wake_at`). The step shows its URL:

```
POST http://127.0.0.1:4317/api/callbacks/<secret>
{ "outcome": "done", "data": { ... } }
```

The POST finishes the run, 1 time. The outcome in the body picks the arrow, and later steps read `{{ steps.ci_green.data.<field> }}`. When `wake_at` passes, the due loop finishes the run with `timeout`. The secret is the only key. The daemon listens on 127.0.0.1, so a system outside this machine needs a tunnel (section 12).

The plan had a `tokens` table. The build has none. In Orstra 1 run has at most 1 wait, so the run row can hold the secret and the due time. A table would help only for a URL that exists before the wait starts, or for many waits in 1 run. Add it when 1 of those needs comes.

**A human step and a callback.** Both are a run in `waiting` that something outside Orstra ends, and both refuse to end while an agent works on the task. A human step can ask for a callback too: `callback: true` gives it a URL, and a script decides by a POST with 1 of the step's choices as the outcome and a comment in `data`. The Decide button still works, and whichever comes first closes the URL. `decide()` and `completeCallback()` stay 2 entry points, and both end in `finish()`.

A waiting `wait` or `workflow` run has the new task state `sleeping` ("Waiting" on the board). It takes no slot and stays out of the Inbox.

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
- **Schedules (t-mwvo9a, merged):** the task's source `schedule:<id>@<due ms>` is also its key. Schedules already checked the source before a start. The key makes the database refuse a second task for the same due time too.
- **Child tasks:** key `<parent run id>:<index>` (section 7).
- **Dogfood loop:** until fan out ships, give agents the variable `ORSTRA_TASK_ID`. The `file` prompt then runs `bin/orstra run orstra-build --key "$ORSTRA_TASK_ID:<finding number>"`. A resumed or retried `file` step then cannot file a finding twice.

## 9. Build or adopt

The unit of work is a CLI process with its session on disk, in a git worktree on this machine. No engine can checkpoint that process. trigger.dev checkpoints its own container, not a `claude` process on the host with files in `~/.claude`. With every engine, the durability of an agent step still comes from the session log and `--resume`. Orstra wrote that code already (`sessionLog.ts`).

| Engine | What it needs | Fit |
| --- | --- | --- |
| trigger.dev self-hosted | Docker, Postgres, Redis, object storage | Poor. Tasks run in its containers, but the agent must run on the host with your repos and your Claude login |
| Temporal | A server and a database. Deterministic workflow code | Poor. Orstra would write a YAML interpreter on top, and a long activity still dies with its worker |
| Inngest, Restate | 1 binary each | Medium. Good timers and events, but a second state store, and the agent step is still 1 long call |
| DBOS | A library. The state goes in your database | Closest idea, but its TypeScript library uses Postgres (I believe) |

What an engine would give is timers, retries, queues and signals. On 1 machine with 1 user and SQLite, each of those is a few columns and 1 loop. Orstra already has the hard part: a run state machine in SQLite, a projection that rebuilds after a restart, and a lock to 1 open run for each task. An engine adds a second source of truth that must agree with SQLite, and it makes Orstra hard to install.

**Recommendation: build it into Orstra, on SQLite.** Use trigger.dev's names and semantics (retry fields, `wait.for` and `wait.until`, callbacks with a URL, `triggerAndWait`, idempotency keys, priority in seconds), so the model is familiar. This is the DBOS idea: the database is the engine.

## 10. Config or code: can the YAML grow to our needs?

trigger.dev defines a workflow in TypeScript. LangGraph builds a graph in Python, but at run time it is still a graph with a checkpoint after each node. Orstra defines the graph in YAML.

**What config gives Orstra.**

- The durable state is "the current step, plus the arrow counts" in SQLite. A resume reads a row. A code engine must find its place inside a function again, with a process snapshot or a replay of deterministic code.
- The version lock is the stored text (`workflow_yaml`), and `refreshWorkflow()` can move a task to a new version because its place has a name.
- The canvas editor can draw and edit the graph, because the graph is data.
- The chief of staff can write a workflow, and the parser checks it. The daemon never runs code that an agent wrote.
- Steps are large (1 agent step can work for 30 minutes), so the graph between them stays thin.

**What config costs.** Each new need can become a keyword, until the YAML is a weak programming language. Templates have no types. Data between steps is free text. Workflows cannot share functions, and nobody can unit test a workflow.

**The rule.** A keyword may only choose a value, wait, or repeat a step. Logic with numbers, "and"/"or", or parsing goes into a script: a gate that writes `{ "outcome", "data" }` to `ORSTRA_OUTPUT`, in any language, with TypeScript through `tsx` as first-class. The outcome of the script is the branch name, as a router function is in LangGraph. 2 small additions close the gaps in branching:

- An agent step may declare its own outcomes in `on:`. Orstra lists them on the OUTCOME line, and `parseAgentResult()` accepts them. Today it accepts only `done`, `needs_you` and `cant_do`.
- A `when:` on a step skips it with the outcome `skipped`. It uses the matching that `switch` uses, so YAML gets no expression language.

**Each need against config.** Branches, skips, loops with `max:`, retries, waits, callbacks, queues, keys and fan out over a list all fit as values. 2 needs do not fit:

1. Parallel branches in 1 task, with a join. YAML can describe them, but the engine allows 1 open run for each task (the unique index `runs_one_open`), and the board, the projection and `decide()` depend on it. Code would hit the same limit. Until a real need comes, run each branch as a child task and let the parent wait.
2. A plan that the agent makes at run time, with mixed step kinds. Fan out covers a plan where each item fits 1 child workflow. A plan such as "agent, then gate, then a human" does not fit.

**Why the choice can change later.** The graph engine is the part that is hard to change, and it is the right part for durability, the board and the human in the loop. The YAML is only the way to write the graph. A TypeScript or Python layer can build the same graph later, as LangGraph does, with no change to the engine. Add that layer when 2 of these signs show up: a keyword needs an expression, authors copy blocks between files, a workflow needs a variable that changes in a loop, or templates go inside templates.

**Recommendation.** Keep config. Add gates that return JSON first. Decide about parallel runs in 1 task when the first real need comes.

## 11. The order to build it in

Each task ships on its own and helps on its own. The daily pain, restarts that kill runs, was fixed on main in `a23bb70`. Task 1 closes its small gaps.

1. **Finish restart survival.** Done on this branch. The 3 actions rerun after a restart (`RERUN_SAFE` in `actions.ts`). A gate or an action with `rerun: false` asks you instead. Each gate runs in its own process group, and `shutdown()` stops the gates. `resumeNote()` names the commits the cut turn left. The grace time of `shutdown()` stays at 5 s: `tsx watch` kills the daemon with SIGKILL after 5 s, and that limit is fixed in tsx, so a longer grace time would not help.
2. **Retries with backoff.** Done. `retry: { max, delay, factor, maxDelay, onTimeout }` on agent and gate steps. A fault (a crash, an API error, a usage limit) becomes a new run with `not_before`. An agent retry resumes the same session. A usage limit with a reset time waits until that time. The arrows see `cant_do` or `timeout` only when the retries run out.
3. **Idempotency keys.** Done. `tasks.idempotency_key`, unique per workflow. `POST /api/tasks` takes `idempotencyKey` and answers `reused: true`. `bin/orstra run --key`. The Linear trigger uses `linear:<issue id>`, and a schedule uses its source `schedule:<id>@<due ms>`. Every agent and gate gets `ORSTRA_TASK_ID` and `ORSTRA_BASE`.
4. **Queues.** Done. Workspace `concurrency` ("At the same time" on the Workspaces page). `Runner.capacity()` checks the 3 limits for queued runs and for held chat messages. Task `priority` in seconds.
5. **Timer waits.** Done. `use: wait` with `for` or `until`, on 1 due loop in the runner (`tick()`). It came before t-mwvo9a merged, so schedules keep their own loop in `Triggers.tick()`. Both keep their due times in SQLite, so neither loses one in a restart.
6. **Callbacks.** Done, without a tokens table (section 6).
7. **Gates that return JSON, agent outcomes in `on:`, and `when:`.** Done. A gate gets `ORSTRA_INPUT` and may write `{ outcome, data }` to `ORSTRA_OUTPUT`.
8. **Child workflows.** Done. `use: workflow` with `for_each` and `wait`. A child starts from the workspace base branch. A new dogfood workflow uses it (below).
**The dogfood workflow.** The file step no longer starts tasks itself. The agent writes the picked findings to `.orstra/artifacts/picked.json`. A gate turns that file into `data.items`, and a `workflow` step starts 1 `orstra-build` task for each item. Each child carries the key `<run id>:<index>`, so a retry or a restart files no finding twice. It is not in `~/.orstra/workflows` yet, because the daemon on main does not know `for_each`, and an early copy would break the daily dogfood until the merge.

9. **Later, if needed:** parallel runs in 1 task, detached processes (Option A), persistent permission questions, named shared queues, a TTL on keys.

## 12. Questions for you

1. **Actions after a restart.** This branch reruns the 3 safe actions on their own after a restart. Do you want that, or should every action ask you?
2. **Retry of an agent.** The build resumes the same session for every retry. Should the last try start a fresh session instead, in case the session itself is in a bad state?
3. **Retry on timeout.** Off by default in the build (`onTimeout: true` turns it on). Is that right?
4. **Outside systems.** Should a system outside this machine (GitHub, CI) complete callbacks? That needs a tunnel or a relay, and auth beyond the secret in the URL. Or is localhost enough for now?
5. **Shared queues.** Do you need a limit that many workflows share, for example "1 agent on the orstra repo at a time", or is the workspace limit enough?
6. **Children and branches.** A child starts from the workspace base branch in the build. Do you also want a choice to start from the parent's branch, so a child builds on the parent's work?
7. **Dogfood.** The new dogfood workflow is ready in `.orstra/artifacts/orstra-dogfood.yaml` (below). Copy it over `~/.orstra/workflows/orstra-dogfood.yaml` after this branch merges and the daemon restarts. Do you want it, or do you prefer the old flow where the agent starts the tasks itself?
8. **Parallel branches.** Do you need parallel branches in 1 task, or plans with mixed step kinds, in the next few months? Those 2 needs would change section 10.
