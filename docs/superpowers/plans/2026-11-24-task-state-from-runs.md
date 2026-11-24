# Task state from runs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a task's state come from its run rows, so every screen says what is true.

**Architecture:** A pure `deriveState` in `@orstra/core` turns the stored facts about a task's runs into 1 state. A projector in the daemon is the only writer of `tasks.status`, `tasks.current_step` and `tasks.inbox_reason`. A partial unique index keeps 1 open run per task. Liveness is never stored: the API computes the state at each read, with the in-memory session map.

**Tech Stack:** TypeScript, Node 22.13+, `node:sqlite`, vitest, React.

**Spec:** `docs/superpowers/specs/2026-11-24-task-state-from-runs-design.md`

## Global Constraints

- A task has at most 1 **open** run. Open means `status` in `queued`, `running`, `waiting`.
- `projectTask` is the only code that writes `tasks.status`, `tasks.current_step` or `tasks.inbox_reason`.
- No stored value may claim a process is alive. Liveness comes only from `Runner.live`.
- The Inbox must keep the same membership as today. The state to status map is fixed:
  `queued | working | checks → running`; `waiting_you | paused | decision | blocked → needs_you`;
  `done → done`; `stopped → stopped`.
- `TaskState` is exactly: `queued | working | checks | waiting_you | paused | decision | blocked | done | stopped`.
- Tests live under `packages/core/test/`, `apps/daemon/test/` and `apps/web/test/`. `npm test` runs them all.
- `npm run typecheck` must pass at every commit.
- The existing database at `~/.orstra/orstra.db` must open and read correctly after the change, with no manual repair.

## Review Focus

1. **Legacy runs carry no `routed`.** The 6 finished tasks in the real database would read as `blocked · lost`. The migration must backfill. Test in Task 2.
2. **A task with no runs at all**, between `insertTask` and `queueStep`, must read as `queued`, never as `blocked · lost`. Test in Task 1.
3. **The web gets a state it does not know** when the daemon and the page are different versions. `STATE[s]` must not be `undefined`, or every screen throws. Test in Task 7.
4. **Stop, then re-run, then stop.** `retry()` must clear `stopped_at`, or a re-run queues a run that `pump()` refuses to start. Test in Task 3.
5. **A pair of (status, kind) the matrix does not name**, such as a `waiting` gate run. `deriveState` must return a named state, never throw and never fall off the end. Test in Task 1.

---

### Task 1: `deriveState` in core

**Files:**
- Create: `packages/core/src/state.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/state.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
```ts
export type TaskState = 'queued' | 'working' | 'checks' | 'waiting_you' | 'paused' | 'decision' | 'blocked' | 'done' | 'stopped';
export type StoredStatus = 'running' | 'needs_you' | 'done' | 'stopped';
export interface OpenRunFacts {
  id: string; stepId: string; kind: string;
  status: 'queued' | 'running' | 'waiting';
  waitReason: string | null; lastTurnAt: number | null; live: boolean;
}
export interface StateInput {
  stoppedAt: number | null;
  hasRuns: boolean;
  open?: OpenRunFacts;
  /** `end` | `block:<reason>` | `goto:<stepId>`, from the newest ended run. */
  lastRouted?: string | null;
  lastStepId?: string | null;
}
export interface DerivedState {
  state: TaskState; stepId: string | null; reason: string | null;
  runId: string | null; lastTurnAt: number | null;
}
export function deriveState(input: StateInput): DerivedState;
export function storedStatus(state: TaskState): StoredStatus;
```

- [ ] **Step 1: Write the failing tests**

```ts
// packages/core/test/state.test.ts
const open = (p: Partial<OpenRunFacts> = {}): OpenRunFacts =>
  ({ id: 'r1', stepId: 'work', kind: 'agent', status: 'running', waitReason: null, lastTurnAt: null, live: true, ...p });
const input = (p: Partial<StateInput> = {}): StateInput => ({ stoppedAt: null, hasRuns: true, ...p });

describe('deriveState with an open run', () => {
  it('reads a live agent run as working', () => expect(deriveState(input({ open: open() })).state).toBe('working'));
  it('reads a dead agent run as paused', () => {
    const d = deriveState(input({ open: open({ live: false, lastTurnAt: 1000 }) }));
    expect(d).toMatchObject({ state: 'paused', lastTurnAt: 1000, stepId: 'work', runId: 'r1' });
  });
  it('reads a live waiting agent run as waiting_you with its reason', () =>
    expect(deriveState(input({ open: open({ status: 'waiting', waitReason: 'question', live: true }) })))
      .toMatchObject({ state: 'waiting_you', reason: 'question' }));
  it('reads a dead waiting agent run as paused', () =>
    expect(deriveState(input({ open: open({ status: 'waiting', waitReason: 'question', live: false }) })).state).toBe('paused'));
  it('reads a waiting human run as decision', () =>
    expect(deriveState(input({ open: open({ kind: 'human', status: 'waiting', live: false }) })).state).toBe('decision'));
  it('reads a running gate run as checks', () =>
    expect(deriveState(input({ open: open({ kind: 'gate', live: false }) })).state).toBe('checks'));
  it('reads a running action run as working, with no session', () =>
    expect(deriveState(input({ open: open({ kind: 'action', live: false }) })).state).toBe('working'));
  it('reads any queued run as queued', () => {
    for (const kind of ['agent', 'gate', 'human', 'action', 'switch'])
      expect(deriveState(input({ open: open({ kind, status: 'queued', live: false }) })).state).toBe('queued');
  });
  // Review Focus 5
  it('names a state for a pair the matrix does not cover', () =>
    expect(deriveState(input({ open: open({ kind: 'gate', status: 'waiting', live: false }) })).state).toBe('decision'));
});

describe('deriveState with no open run', () => {
  it('reads a stopped task as stopped, over everything else', () =>
    expect(deriveState(input({ stoppedAt: 5, open: open() })).state).toBe('stopped'));
  it('reads end as done', () =>
    expect(deriveState(input({ lastRouted: 'end', lastStepId: 'done' })).state).toBe('done'));
  it('reads a block as blocked, with its reason', () =>
    expect(deriveState(input({ lastRouted: 'block:conflict', lastStepId: 'merge' })))
      .toMatchObject({ state: 'blocked', reason: 'conflict', stepId: 'merge' }));
  it('reads a goto with no open run as lost, which is a bug signal', () =>
    expect(deriveState(input({ lastRouted: 'goto:work' }))).toMatchObject({ state: 'blocked', reason: 'lost' }));
  // Review Focus 2
  it('reads a task with no runs yet as queued', () =>
    expect(deriveState(input({ hasRuns: false })).state).toBe('queued'));
  it('reads a task that has runs but no routed run as lost', () =>
    expect(deriveState(input({ lastRouted: null }))).toMatchObject({ state: 'blocked', reason: 'lost' }));
});

describe('storedStatus', () => {
  it('keeps the Inbox membership of today', () => {
    expect(['queued', 'working', 'checks'].map(storedStatus)).toEqual(['running', 'running', 'running']);
    expect(['waiting_you', 'paused', 'decision', 'blocked'].map(storedStatus)).toEqual(['needs_you', 'needs_you', 'needs_you', 'needs_you']);
    expect(storedStatus('done')).toBe('done');
    expect(storedStatus('stopped')).toBe('stopped');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/core/test/state.test.ts`
Expected: FAIL, `deriveState` is not exported.

- [ ] **Step 3: Implement `deriveState` and `storedStatus` in `packages/core/src/state.ts`**

Order of the branches: `stoppedAt` first, then the open run, then `lastRouted`, then `hasRuns`. Inside
the open run, branch on `status` first and on `kind` second, and use `live` only to split
`working`/`paused` and `waiting_you`/`paused`. For a kind the matrix does not name, a `waiting` run
reads as `decision` and a `running` run reads as `working`. Keep the function pure: no clock, no IO.

- [ ] **Step 4: Export from `packages/core/src/index.ts`**

Add `export * from './state.ts';`.

- [ ] **Step 5: Run the tests and the typecheck**

Run: `npx vitest run packages/core/test/state.test.ts && npm run typecheck`
Expected: PASS, and no type errors.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/state.ts packages/core/src/index.ts packages/core/test/state.test.ts
git commit -m "core: deriveState turns a task's run facts into 1 state"
```

---

### Task 2: The schema, the index and the migration

**Files:**
- Modify: `apps/daemon/src/db.ts`
- Test: `apps/daemon/test/db.test.ts` (create)

**Interfaces:**
- Consumes: Task 1's types, for nothing yet.
- Produces:
```ts
// on RunRow: last_turn_at: number | null; wait_reason: string | null; routed: string | null
// on TaskRow: stopped_at: number | null
openRuns(): RunRow[];                        // every run with status queued | running | waiting
openRun(taskId: string): RunRow | undefined;
lastEndedRun(taskId: string): RunRow | undefined;  // newest run with status done | failed and a non-null outcome
```

- [ ] **Step 1: Write the failing tests**

```ts
// apps/daemon/test/db.test.ts
describe('the open run invariant', () => {
  it('refuses a second open run for 1 task', () => {
    const s = new Store(':memory:');
    insertTask(s, 't1'); insertRun(s, 't1', 'r1', 'waiting');
    expect(() => insertRun(s, 't1', 'r2', 'queued')).toThrow();
  });
  it('allows a second run once the first closed', () => {
    const s = new Store(':memory:');
    insertTask(s, 't1'); insertRun(s, 't1', 'r1', 'waiting');
    s.updateRun('r1', { status: 'done' });
    expect(() => insertRun(s, 't1', 'r2', 'queued')).not.toThrow();
  });
  it('allows 1 open run each for 2 tasks', () => { /* t1 and t2, both waiting, no throw */ });
});

describe('opening a database written by the old version', () => {
  // Review Focus 1
  it('adds the new columns and backfills routed from the old task status', () => {
    const file = writeOldDatabase();  // tasks + runs with the pre-change schema, 1 done task, 1 needs_you task with no open run
    const s = new Store(file);
    expect(s.lastEndedRun('t-done')!.routed).toBe('end');
    expect(s.lastEndedRun('t-stuck')!.routed).toBe('block:conflict');  // from the old inbox_reason
    expect(s.run('r-open')!.routed).toBe(null);                        // an open run routed nowhere yet
  });
  it('opens a second time with no error', () => { /* new Store(file) twice */ });
});
```

`writeOldDatabase` builds a file with the pre-change `CREATE TABLE` statements and a few rows, so the
test exercises the real migration path and not a fresh schema.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run apps/daemon/test/db.test.ts`
Expected: FAIL, the columns do not exist and the insert does not throw.

- [ ] **Step 3: Add the columns, the index and the migration in `apps/daemon/src/db.ts`**

- Add the 3 run columns and `tasks.stopped_at` to `SCHEMA`, and the index:
```sql
CREATE UNIQUE INDEX IF NOT EXISTS runs_one_open ON runs(task_id) WHERE status IN ('queued','running','waiting');
```
- Add `private ensureColumns()`, called from the constructor before the index is made. It reads
  `PRAGMA table_info(<table>)` and runs `ALTER TABLE … ADD COLUMN` for each column that is absent.
- Add `private backfillRouted()`, run once when `routed` was just added: for each task with no open
  run, set `routed` on its newest ended run to `end` when the task's status is `done`, and to
  `block:<inbox_reason>` when it is `needs_you` with a reason, else `block:unknown`.
- Add `openRuns`, `openRun` and `lastEndedRun`.

- [ ] **Step 4: Run the tests, the whole suite and the typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS. The existing daemon tests must still pass, because nothing writes the new columns yet.

- [ ] **Step 5: Check the real database opens**

Run: `cp ~/.orstra/orstra.db /tmp/check.db && node --experimental-strip-types -e "import('./apps/daemon/src/db.ts').then(m => { const s = new m.Store('/tmp/check.db'); console.log(s.tasks().length, s.openRuns().length); })"`
Expected: `9 3`, and no error. Never run this against `~/.orstra/orstra.db` itself.

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src/db.ts apps/daemon/test/db.test.ts
git commit -m "db: 1 open run per task, 3 run facts, and a migration that backfills routed"
```

---

### Task 3: Write the facts

**Files:**
- Modify: `apps/daemon/src/runner.ts`
- Test: `apps/daemon/test/runner.test.ts`

**Interfaces:**
- Consumes: Task 2's columns and `openRun`.
- Produces:
```ts
// on Runner
private closeOpenRuns(taskId: string, outcome: string | null, exceptRunId?: string): void;
```
  It closes every run with status `queued`, `running` or `waiting`: `status: 'stopped'`,
  the given `outcome`, `ended_at: Date.now()`, and it kills that run's live session.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/daemon/test/runner.test.ts
it('records what the router decided on the run that ended', async () => {
  // REVIEW workflow: after the agent finishes, its run carries routed 'goto:review';
  // after you close, the review run carries routed 'end'
});
it('records a block on the run whose outcome had no arrow', async () => {
  // LOOP with a failing gate past its cap: the last gate run carries routed 'block:loop_exhausted'
});
it('writes the time a turn ended on the run', async () => {
  // after the agent asks a question, the run's last_turn_at is within 2 s of now
});
it('writes the wait reason on the run, not only on the task', async () => {
  // question → run.wait_reason 'question'; your reply with no outcome → 'reply'
});
it('re-runs a step that was queued without breaking the 1 open run rule', async () => {
  // Review Focus: a task with a queued run, then runner.retry(): no throw, 1 open run after
});
it('clears the stop when you re-run a stopped task', async () => {
  // Review Focus 4: stop(), then retry(): stopped_at is null and the run starts
  // then stop() again: stopped_at is set again
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run apps/daemon/test/runner.test.ts`
Expected: FAIL. `routed`, `last_turn_at` and `wait_reason` are never written, and the retry over a
queued run raises `SQLITE_CONSTRAINT` from the new index.

- [ ] **Step 3: Write the facts in `apps/daemon/src/runner.ts`**

- `finish()`: after `route()` returns, write `routed` on the run: `goto:<step>`, `end` or
  `block:<reason>`, in the same `updateRun` call that already sets `status`, `outcome` and `ended_at`.
- `onTurn()`: write `last_turn_at: Date.now()` on the run at the top, before any branch.
- `markWaiting()`: write `wait_reason` on the run beside `status: 'waiting'`.
- Add `closeOpenRuns`, and use it in `retry()`, `stop()` and `sendBack()` in place of their 3 current
  loops. `sendBack()` passes `outcome: 'reopened'` and `exceptRunId: target.id`; `retry()` and
  `stop()` pass `null`.
- `stop()`: write `stopped_at: Date.now()` on the task. `retry()`: write `stopped_at: null`.

- [ ] **Step 4: Run the whole suite and the typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/runner.ts apps/daemon/test/runner.test.ts
git commit -m "runner: store the facts the state is read from"
```

---

### Task 4: The projector

**Files:**
- Create: `apps/daemon/src/project.ts`
- Modify: `apps/daemon/src/runner.ts`
- Test: `apps/daemon/test/project.test.ts` (create)

**Interfaces:**
- Consumes: Task 1's `deriveState`/`storedStatus`, Task 2's `openRun`/`lastEndedRun`, Task 3's facts.
- Produces:
```ts
export type IsLive = (runId: string) => boolean;
/** `runs` is optional: a caller that already loaded the task's runs passes them, so a read costs 1 query. */
export function taskFacts(store: Store, isLive: IsLive, task: TaskRow, runs?: RunRow[]): StateInput;
export function projectTask(store: Store, isLive: IsLive, taskId: string): DerivedState;
export function rebuildAll(store: Store, isLive: IsLive): { taskId: string; from: string; to: string }[];
```
  `projectTask` writes `status`, `current_step` and `inbox_reason` and returns what it derived.
  `rebuildAll` projects every task and returns only the ones whose stored status changed.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/daemon/test/project.test.ts
it('writes the 3 columns from the runs', () => { /* a waiting human run → needs_you, decision, its step */ });
it('says running with no reason while the agent works', () => { /* live agent run → running, inbox_reason null */ });
it('says needs_you with the reason paused when the session is gone', () => { /* isLive false → needs_you, 'paused' */ });
it('reports only the tasks it changed', () => { /* rebuildAll over an already correct store returns [] */ });

// apps/daemon/test/runner.test.ts
it('keeps the task row true at every step of a task', async () => {
  // start → running/null; question → needs_you/question; chat → running/null;
  // decision → needs_you/decision; close → done/null; stop → stopped
});
it('has no writer of the task state but the projector', () => {
  // read every .ts under apps/daemon/src; the only file that passes status, current_step or
  // inbox_reason to updateTask is project.ts
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run apps/daemon/test/project.test.ts apps/daemon/test/runner.test.ts`
Expected: FAIL. `project.ts` does not exist, and the guard test finds the writes in `runner.ts`.

- [ ] **Step 3: Implement `apps/daemon/src/project.ts`**

`taskFacts` reads `openRun`, `lastEndedRun` and the task's `stopped_at`, and sets `hasRuns` from
whether the task has any run at all.

- [ ] **Step 4: Call it from `apps/daemon/src/runner.ts` and remove every other writer**

- Add `private project(taskId: string)` that calls `projectTask(this.store, (id) => this.live.has(id), taskId)`
  and then `this.changed(taskId)`.
- Delete the `status`, `current_step` and `inbox_reason` fields from every `updateTask` call in
  `runner.ts`: `startTask`, `queueStep`, `finish`, `markWaiting`, `message`, `sendBack`, `stop`,
  `recover`. Keep the other fields those calls write, such as `edge_counts` and `stopped_at`.
- Call `this.project(taskId)` at the end of each of those paths, and in `onClosed`.
- `startTask` inserts the task with `status: 'running'`, `current_step: null`, `inbox_reason: null`
  as placeholders, then `queueStep` and `project` set the truth.

- [ ] **Step 5: Run the whole suite and the typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS. Nothing in the existing tests should need a change, because the stored values are
the same values.

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src/project.ts apps/daemon/src/runner.ts apps/daemon/test/project.test.ts apps/daemon/test/runner.test.ts
git commit -m "daemon: 1 projector writes the task's state, and nothing else does"
```

---

### Task 5: Restart and rebuild

**Files:**
- Modify: `apps/daemon/src/runner.ts`, `apps/daemon/src/server.ts`, `apps/daemon/src/cli.ts`
- Test: `apps/daemon/test/runner.test.ts`

**Interfaces:**
- Consumes: Task 4's `rebuildAll`.
- Produces: `POST /api/rebuild` with an optional `{ taskId }`, which answers
  `{ changed: { taskId, from, to }[] }`. `orstra rebuild [taskId]` prints 1 line per changed task.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/daemon/test/runner.test.ts
it('reads an agent run as paused after a restart, and frees its slot', async () => {
  // a question leaves a waiting run; a second Runner over the same store calls recover()
  // the run is waiting with wait_reason 'paused'; the task is needs_you with inbox_reason 'paused'
  // runsByStatus('running') is empty, so pump has its slot and idle() returns
});
it('still fails a gate run that died with the process', async () => {
  // a gate run left running → failed, outcome 'interrupted'
});
it('rebuilds the same state it had', async () => {
  // run a task to a decision, note the 3 columns, scribble a wrong status directly,
  // rebuildAll → the columns are back and the call reports 1 changed task
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run apps/daemon/test/runner.test.ts`
Expected: FAIL. `recover()` still writes `restarted` and repairs the task row itself.

- [ ] **Step 3: Change `recover()` in `apps/daemon/src/runner.ts`**

An agent run with a session moves to `status: 'waiting'`, `wait_reason: 'paused'`, and keeps its
system event with the sentence it has today. A `gate` or `action` run still ends as `failed` with the
outcome `interrupted` and `routed: 'block:interrupted'`. `recover()` writes no task fields. It ends
with `rebuildAll`, then `pump()`.

- [ ] **Step 4: Add the route and the command**

`POST /api/rebuild` in `buildApi`, next to the other task routes. `orstra rebuild [taskId]` in
`cli.ts`, with its line in `HELP`.

- [ ] **Step 5: Run the whole suite and the typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS. The existing test "resumes the same session when you message it after a restart"
must still pass.

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src/runner.ts apps/daemon/src/server.ts apps/daemon/src/cli.ts apps/daemon/test/runner.test.ts
git commit -m "daemon: a restart leaves a paused run, and rebuild can redo the projection"
```

---

### Task 6: The API answers with the state

**Files:**
- Modify: `apps/daemon/src/server.ts`, `apps/daemon/src/cos.ts`
- Test: `apps/daemon/test/runner.test.ts`

**Interfaces:**
- Consumes: Task 1's `deriveState`, Task 4's `taskFacts`.
- Produces: `taskSummary` and `taskDetail` gain `state: TaskState`, `stateReason: string | null`,
  `lastTurnAt: number | null`. `status`, `inboxReason` and `currentStep` stay as they are.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/daemon/test/runner.test.ts
it('answers with the live state, computed at the read', async () => {
  const views = makeViews(store, runner);
  // while the agent works
  expect(views.taskSummary(store.task(id)!).state).toBe('working');
  // a second Runner over the same store, with no live sessions and no write of any kind
  const views2 = makeViews(store, new Runner(store, fake.exec, opts));
  expect(views2.taskSummary(store.task(id)!).state).toBe('paused');
  expect(store.task(id)!.status).toBe('running');  // nothing was written by the read
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run apps/daemon/test/runner.test.ts`
Expected: FAIL, `state` is undefined.

- [ ] **Step 3: Compute the state in `makeViews`**

`taskSummary` already loads `store.runsForTask(t.id)`. Pass those rows to `taskFacts`, so the read
costs no extra query:
`const d = deriveState(taskFacts(store, (id) => runner.isLive(id), t, runs));`
Spread `state: d.state`, `stateReason: d.reason` and `lastTurnAt: d.lastTurnAt` onto `taskSummary`.
`taskDetail` spreads `taskSummary`, so it inherits them.

- [ ] **Step 4: Read the new field in `apps/daemon/src/cos.ts`**

`list_tasks` reports `state` and `waitingFor: s.stateReason`. `get_task` reports `state` beside
`status`. Nothing else changes.

- [ ] **Step 5: Run the whole suite and the typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src/server.ts apps/daemon/src/cos.ts apps/daemon/test/runner.test.ts
git commit -m "api: every task view carries the state it is really in"
```

---

### Task 7: The screens read the state

**Files:**
- Modify: `apps/web/src/api.ts`, `apps/web/src/lib/taskState.ts`, `apps/web/src/lib/describe.ts`,
  `apps/web/src/pages/Inbox.tsx`
- Test: `apps/web/test/taskState.test.ts`

**Interfaces:**
- Consumes: Task 6's `state`, `stateReason`, `lastTurnAt` on `TaskSummary`.
- Produces: `taskState(t)` returns the API's state. `STATE` has 1 entry per `TaskState`.

`apps/web` does not depend on `@orstra/core`, so it cannot import `TaskState`. Declare the union
again in `apps/web/src/api.ts`, beside `RunStatus`, which is how the web already mirrors the daemon's
types. The 2 lists can drift, and the fallback in Step 3 is what keeps a drift from breaking a screen.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/web/test/taskState.test.ts
it('returns the state the daemon computed', () =>
  expect(taskState({ state: 'paused' } as TaskSummary)).toBe('paused'));
it('has a label, a colour and a group for every state', () => {
  for (const s of ['queued','working','checks','waiting_you','paused','decision','blocked','done','stopped'])
    expect(STATE[s]).toMatchObject({ label: expect.any(String), group: expect.any(String) });
});
// Review Focus 3
it('does not throw on a state it does not know', () =>
  expect(() => STATE[taskState({ state: 'something_new' } as any)].label).not.toThrow());
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run apps/web/test/taskState.test.ts`
Expected: FAIL. `taskState` still reads `status` and `inboxReason`, and `STATE` has 7 entries.

- [ ] **Step 3: Rewrite `apps/web/src/lib/taskState.ts`**

`taskState(t)` returns `t.state` when `STATE` has it, else `'blocked'`. `STATE` keeps its shape and
gains `working` (replaces `running`), `checks`, `waiting_you` (replaces `question`), `paused` and
`blocked` (replaces `stuck`). Labels: Running, Checks, Waiting for you, Paused, Stuck. Groups stay
`needs | running | queued | done`, matching the stored status map in the constraints.

- [ ] **Step 4: Follow the renames**

`describe.ts` gets a sentence for `paused` ("Claude Code's session is closed. Message it and it picks
the work back up.") and for `blocked` with the reason `lost` ("Nothing holds this task. Re-run the
step."). `Inbox.tsx`'s `GROUPS` uses the new names. `api.ts` adds the `TaskState` union and the 3
fields to `TaskSummary`.

- [ ] **Step 5: Run the whole suite, the typecheck and the build**

Run: `npm test && npm run typecheck && npm run build`
Expected: PASS, and the build writes `apps/web/dist`.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src apps/web/test/taskState.test.ts
git commit -m "web: the screens read the state the daemon computed"
```

---

### Task 8: The 5 real cases

**Files:**
- Test: `apps/daemon/test/state-truth.test.ts` (create)

**Interfaces:**
- Consumes: everything above. This task writes no production code. If a case fails, the fix goes in
  the task that owns the code, and this file stays as it is.

- [ ] **Step 1: Write the 5 scenario tests**

```ts
// apps/daemon/test/state-truth.test.ts
it('t-mwtzpbti2n1a: a chat at a decision does not leave the board at Decide', async () => {
  // REVIEW workflow to the decision, message the agent, read the view: state 'working', step 'work'
});
it('t-mwt5ry: work after the run ended lands in a run row with a progress entry', async () => {
  // the same chat, then the agent finishes: a run row for attempt 2 with progress and an outcome
});
it('t-mwt5ry: an approval cannot land while the agent works', async () => {
  // message the agent at the decision, then decide() on the old human run throws
});
it('t-mwt4ootxs8gp: a run with no live session reads as paused, with the time of its last turn', async () => {
  // a question, then a second Runner: state 'paused', lastTurnAt within 2 s of the turn
});
it('a task whose last run routed nowhere reads as stuck, not as running', async () => {
  // close the only open run by hand, project, and read: state 'blocked', reason 'lost'
});
```

- [ ] **Step 2: Run them**

Run: `npx vitest run apps/daemon/test/state-truth.test.ts`
Expected: PASS, all 5. A failure here means a task above is wrong; fix it there.

- [ ] **Step 3: Run everything**

Run: `npm test && npm run typecheck && npm run build`
Expected: PASS.

- [ ] **Step 4: Check the real database once more**

Run: `cp ~/.orstra/orstra.db /tmp/final.db` then open `/tmp/final.db` with the new `Store` and print
each task's derived state. Expected: the 6 finished tasks read `done`, `t-mwt4qs7by1xx` and
`t-mwtzpbti2n1a` read `decision`, `t-mwt4ootxs8gp` reads `paused`. No task reads `blocked · lost`.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/test/state-truth.test.ts
git commit -m "test: the 5 cases that started this, each named after its bug"
```
