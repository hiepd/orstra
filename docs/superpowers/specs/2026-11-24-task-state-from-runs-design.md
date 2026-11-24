# The state of a task comes from its runs

Design, 24 November 2026. Status: for approval.

## Intent

A task's screen must say what is true. Today it says what the state machine last wrote.

Orstra stores 3 facts on a task: `status`, `inbox_reason` and `current_step`. Only `route()` writes
them, and only when a step finishes. Anything that happens between 2 routings changes nothing. 5 real
cases came out of `~/.orstra/orstra.db` on 24 November:

| Task | The board said | The runs said |
| --- | --- | --- |
| t-mwtzpbti2n1a | In review · Decide, from 12:22:24 | 42 events on the **ended** run after 12:22:24, to 12:48:21 |
| t-mwt5ry6u6x7u | In review for 13 hours | 147 events on the ended run, 23 Nov 22:34 to 24 Nov 11:49, in 0 run rows |
| t-mwt5ry6u6x7u | Merged at 11:32:10 | The agent changed files until 11:49:44, after the merge |
| t-mwt4qs7by1xx | Past the Merge step | No merge run exists. 1 commit sits on `orstra/step-artifacts`, out of main |
| t-mwt4ootxs8gp | Agent is waiting for you | 1 run row has said `waiting` for 27 hours, over a silent night and a live exchange |

4 of the 5 share 1 rule: the run row is the only unit of truth, and only the state machine makes one.
This design makes the run rows the truth for the task's state as well, and makes every piece of work
have a run row.

## Goals

1. Every screen reads the task's state from the same place, and that place is the run rows.
2. A task has at most 1 **open** run. The database enforces it.
3. Work that an agent does always has a run row, an outcome and a progress entry.
4. A decision cannot stand while an agent works, so an approval cannot merge a diff in flight.
5. A reader can tell "the agent answered you 2 minutes ago" from "nothing has moved since yesterday".
6. The state can be rebuilt from the runs with 1 command, for any task or for all of them.

## Non-goals

- The fact log (option C). This design is its first projection, and nothing here blocks it.
- `review` as a condition instead of a step. That change comes later and this design makes it cheaper.
- An approval that points at a commit. Later, with the above.
- Bug 4, the track drawn from today's YAML. See Known gaps.
- Any change to the workflow file format.
- Any change to what reaches the Inbox. The same tasks arrive there as today.

## Anti-goals

Things that make this a failure even when it works:

- A second writer of the task's state. If any code outside the projector writes `status`,
  `inbox_reason` or `current_step`, the drift is back and the work was wasted.
- A stored value that claims a process is alive. Orstra already lost that bet: `recover()` exists
  because rows said `running` after the process had died.
- A read that walks every event. This must stay cheap for the board, which reads every task.
- A regression in the Inbox. A restart must not change which tasks ask for you.

## Constraints

- 1 daemon process, 1 writer, SQLite with WAL. No concurrency problem to solve.
- SQLite 3.51 through `node:sqlite`. Partial unique indexes are available.
- The real database has 9 tasks and already keeps the invariant: 3 tasks have exactly 1 open run,
  6 have none and are `done`. No data has to be repaired.
- `@orstra/core` holds the pure logic (`route`, `parseAgentResult`). The daemon holds the IO. The web
  reads the daemon's API. Keep that split.
- The branch `orstra/chat-routes` already carries the change that gives a chat its own run row. This
  design keeps it and builds on it.

## Approaches

4 ways were considered. The user picked A.

**Patch each hole.** Fix cases as they appear. Costs nothing now. Fixes 1 of the 5. Leaves the cause.

**B, a second field.** Add `activity` and `activity_run_id` next to `current_step`. The session layer
writes them. Smallest change, and the board stops lying. Rejected: 2 writers of the same truth brings
the same drift back, it stores liveness on disk, and the agent's work still earns no run row, so 2 of
the 5 cases stay broken.

**A, the runs are the truth.** The task's state is computed from its run rows plus the sessions that
are alive in memory. 1 open run per task. Chosen. It fixes 4 of the 5, it has 1 writer, and it is the
first projection that option C needs, so none of the work is thrown away.

**C, the facts are the truth.** A typed log of what happened; `tasks` and `runs` become tables that
are rebuilt from it. The right end state, because the shape of the model is still moving. Not now: the
present `events` table is a display transcript of 624 untyped rows for 1 task, so C needs a second,
small, typed stream beside it, and a half-built C is worse than a finished A. A is its first move.

## The design

### The 2 layers, and why there are 2

| | Where it lives | Who writes it | Who reads it |
| --- | --- | --- | --- |
| **The coarse status** | `tasks.status`, `current_step`, `inbox_reason` | the projector, alone | the Inbox query, `pump()`, `message()`, the chief of staff's watches, the board's Done column |
| **The live state** | computed at each read | nobody, it is never stored | every screen |

The split matters. The coarse status must never depend on a running process, or a crash leaves a lie
on disk. The live state may, because it is computed in the process that owns the sessions.

### What is stored and what is computed

**Stored facts** (written once, never recomputed):

- `tasks`: every column it has today except the 3 projected ones, plus a new `stopped_at`.
- `runs`: every column it has today, plus `last_turn_at`, `wait_reason` and `routed`.
- `events`: unchanged.

`edge_counts` stays a stored fact. It records which arrows the task has taken, which no later read
can recover.

**The projection**: `tasks.status`, `tasks.current_step`, `tasks.inbox_reason`. The columns keep
their names, their types and their values, so every reader keeps working. What changes is who writes
them, and that they can always be rebuilt.

**In memory only**: whether a session is alive. It lives in `Runner.live` and is never written down.

### The invariant

A task has at most 1 **open** run, where open means `queued`, `running` or `waiting`.

```sql
CREATE UNIQUE INDEX IF NOT EXISTS runs_one_open
  ON runs(task_id) WHERE status IN ('queued','running','waiting');
```

The database refuses a second one. The promise becomes a constraint, which is the answer to this
design's main risk. The real data already keeps it, so the index applies with no repair.

1 helper closes open runs, and every path uses it:

```ts
closeOpenRuns(taskId, { outcome, except? })  // status 'stopped', ended_at now, for queued | running | waiting
```

`retry()`, `stop()` and `sendBack()` call it. Today `retry()` and `sendBack()` miss `queued` runs,
which is the 1 path that can hit the index. A violation is a bug in this logic, not a user error: it
raises, the API answers 500, and the daemon logs the task and both run ids.

### 3 new run columns

**`last_turn_at`** holds the time an agent's turn last ended on that run. `Runner.onTurn` already
fires at that moment, so there is 1 write site. It answers "last turn 27 h ago".

**`wait_reason`** holds why an open agent run waits: `question`, `reply` or `paused`. `markWaiting()`
already computes it and writes it to `tasks.inbox_reason` today. It belongs to the run, so it moves
there, and the projector copies it out.

**`routed`** records what the router decided when the run ended: `goto:<stepId>`, `end`, or
`block:<reason>`. `finish()` already computes this and throws it away. With it stored, the projector
needs no workflow file, no `route()` call and no edge counts, so a later edit to a YAML file cannot
change what the board says about a task that already finished.

### The live state

A pure function in `@orstra/core`, with no workflow and no clock in its inputs:

```ts
deriveState(input: {
  stoppedAt: number | null;
  open?: { id: string; stepId: string; kind: string; status: 'queued' | 'running' | 'waiting';
           waitReason: string | null; lastTurnAt: number | null; live: boolean };
  lastRouted?: string | null;    // 'end' | 'block:<reason>' | 'goto:<id>' from the newest ended run
}): { state: TaskState; stepId: string | null; reason: string | null; runId: string | null }
```

`TaskState` is `queued | working | checks | waiting_you | paused | decision | blocked | done | stopped`.

With no open run:

| `stoppedAt` / `lastRouted` | state |
| --- | --- |
| `stopped_at` set | `stopped` |
| `end` | `done` |
| `block:<reason>` | `blocked`, reason `<reason>` |
| `goto:<id>`, or nothing at all | `blocked`, reason `lost`. A bug, and the screen says so |

With an open run, the branch is on the run's **status** first, because that is a stored fact, and on
liveness only inside it. This matrix is exhaustive over the 3 open statuses and the 5 kinds:

| run status | agent | gate | human | action, switch, workflow |
| --- | --- | --- | --- | --- |
| `queued` | `queued` | `queued` | `queued` | `queued` |
| `running` | `live ? working : paused` | `checks` | n/a | `working` |
| `waiting` | `live ? waiting_you : paused` | n/a | `decision` | `decision` |

`waiting_you` carries the run's `wait_reason`. `paused` carries `last_turn_at`, and the UI turns that
into "last turn 27 h ago".

Note what the matrix does **not** do: it never asks whether a turn is in flight. A run that is
`running` with a live session reads as `working` for its whole life, including the 1.5 second grace
window in `closeAfterGrace`, where a turn has ended and the run has not finished yet. An earlier
draft branched on the turn and made a task flash "waiting for you" just before it finished.

### The coarse status, and why the Inbox does not change

The projector maps the live state onto today's 4 values. The mapping is chosen so that exactly the
same tasks reach the Inbox as today:

| live state | stored `status` | stored `inbox_reason` |
| --- | --- | --- |
| `queued`, `working`, `checks` | `running` | null |
| `waiting_you` | `needs_you` | the run's `wait_reason` |
| `paused` | `needs_you` | `paused` |
| `decision` | `needs_you` | `decision` |
| `blocked` | `needs_you` | the block reason |
| `done` | `done` | null |
| `stopped` | `stopped` | null |

`paused` replaces the old `restarted` reason and lands in the same place, so a restart puts the same
tasks in the Inbox and fires the same chief of staff watches as it does today.

The stored status must not flip on liveness alone. It does not: `working` and `paused` both come from
a `running` agent run, and `recover()` normalises those at startup (below), so no row stays `running`
with no process behind it.

### `recover()` keeps its job, with a smaller reason

An agent run that was `running` when the daemon died is still an open run with a session that can be
resumed. `recover()` keeps 2 things it does today, because `runs.status` is also the ledger that
`pump()` counts slots with and that `idle()` waits on:

- An agent run moves from `running` to `waiting`, with `wait_reason = 'paused'`.
- A `gate` or `action` run that was `running` ends as `failed`, outcome `interrupted`, because its
  process really is gone.

What goes away is the `restarted` inbox reason and the repair of the task row. The task row is a
projection now, so `recover()` ends with a rebuild.

### The projector

```ts
projectTask(taskId): void   // read the facts, call deriveState, write the 3 columns, emit 'change'
```

- It is the **only** code that writes `status`, `current_step` or `inbox_reason`. A test asserts it
  with a search of the source.
- `Runner` calls it after every change: a run is queued, a run starts, a turn ends, a run waits, a run
  finishes, a chat sends a step back, a task stops, a session closes.
- It is cheap: 1 read of that task's runs, which are indexed by `task_id`.

The API does **not** read `state` back from the columns. `makeViews` calls `deriveState` on each read,
with the live map it already uses for `runView.live`. So a screen is right the moment a session dies,
with no timer and no write. The columns carry the coarse status for the queries that need SQL.

For the board, which reads every task, 1 query returns every open run:
`SELECT * FROM runs WHERE status IN ('queued','running','waiting')`. By the invariant that is 1 row
per live task, so the list costs 2 queries in all, not 2 per task.

### `stopped_at`, and what clears it

`stop()` writes it. **`retry()` clears it**, which keeps a promise the product already makes in its
own words: "This task is stopped, so your message does not move it. Re-run a step to start work
again." Without that line a re-run would queue a run that `pump()` then refuses to start.

### Rebuild

`orstra rebuild [taskId]` runs the projector over 1 task or all of them and reports what changed. It
proves the projection is derived and not authored, it repairs a bad state after a future bug, and it
is the shape option C needs later. `recover()` calls it at startup.

### The API

`taskSummary` and `taskDetail` gain:

```ts
state: TaskState;
stateReason: string | null;
lastTurnAt: number | null;
```

`status`, `inboxReason` and `currentStep` stay on the response for 1 release, so nothing breaks at
once. The web stops reading them.

### The UI follows

`apps/web/src/lib/taskState.ts` stops computing the state from `status` and `inboxReason`. It returns
the API's `state`, and the `STATE` map gains `paused`, `checks` and `blocked`. That removes the second
implementation of this logic, which is itself a source of disagreement between screens.

`describe.ts` gains a sentence for `paused` ("Claude Code's session is closed. Message it and it picks
the work back up.") and for `blocked · lost`.

### Where the code changes

| File | Change |
| --- | --- |
| `packages/core/src/state.ts` | new. `TaskState`, `deriveState`, the 2 tables above |
| `packages/core/src/index.ts` | export them |
| `apps/daemon/src/db.ts` | `tasks.stopped_at`; `runs.last_turn_at`, `wait_reason`, `routed`; the partial unique index; a guarded `ALTER TABLE` for an existing file; `openRuns()` |
| `apps/daemon/src/runner.ts` | `projectTask`, `closeOpenRuns`; every direct write of the 3 columns goes; `onTurn` writes `last_turn_at`; `markWaiting` writes `wait_reason`; `finish` writes `routed`; `stop` writes `stopped_at`; `retry` clears it; `recover` rebuilds |
| `apps/daemon/src/server.ts` | `state`, `stateReason`, `lastTurnAt` on both views, from `deriveState` and the live map |
| `apps/daemon/src/cli.ts` | `rebuild` command |
| `apps/daemon/src/cos.ts` | `list_tasks` and `get_task` report the new state |
| `apps/web/src/lib/taskState.ts` | read `state`; add `paused`, `checks`, `blocked` |
| `apps/web/src/lib/describe.ts` | sentences for the new states |
| `apps/web/src/pages/Tasks.tsx`, `Inbox.tsx`, `TaskPage.tsx` | labels only |

### Tests

- **core**, table driven: 1 case per cell of the open-run matrix, and 1 per row of the no-open-run
  table, including `blocked · lost`.
- **the grace window**: a run whose turn has ended but which has not finished reads as `working`,
  never as `waiting_you`.
- **the invariant**: the index refuses a second open run; a retry over a `queued` run does not raise,
  because `closeOpenRuns` closed it first.
- **the projector** after each transition: start, turn end, question, chat sends back, decision,
  stop, retry after stop, finish.
- **restart**: a second `Runner` over the same store reads an agent run as `paused` with the same
  Inbox membership as today, and a gate run as failed. `idle()` returns and `pump()` has its slot back.
- **rebuild** reproduces the state of a task built by a normal run.
- **1 guard test**: no file other than the projector writes `status`, `current_step` or
  `inbox_reason`.
- **the 5 real cases**, each as a scenario test named after the bug it closes.
- **web**: `STATE` has an entry for every member of `TaskState`.

## Known gaps, on purpose

1. **The track is drawn from today's YAML** (bug 4). A task that never merged still shows Merge as
   done. The 2 fixes are to pin the workflow version to the task at its start, or to draw the track
   from the runs that happened plus the steps that remain. This needs a product decision, because
   today an edit to a workflow reaches tasks that already run. Still open.
2. **A chat at a decision moves the card** to the agent's step. That follows from the invariant: the
   open run names the step. When `review` becomes a condition instead of a step, the card stops
   moving, because the work never leaves its step. That is the later change, not this one.
3. **2 columns named Done** on the board, one for the `done` human step and one for finished tasks.
   A label fix, and it disappears with gap 2.

## Left to the builder

- The exact wording of the new UI sentences.
- The shape of the `rebuild` output.
- Whether to delete `status`, `inbox_reason` and `current_step` from the API after 1 release.
- Whether `routed` is 1 text column or 2 (`routed_kind`, `routed_to`).
