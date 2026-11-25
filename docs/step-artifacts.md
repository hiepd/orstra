# How a step produces artifacts for the review

A design note: one word, 3 options, 1 recommendation.

**Status: built, as a general system.** Any agent or gate step keeps a file by writing it under
`.orstra/artifacts/`; Orstra stores it per run, hands it to the next run at `.orstra/inputs/<step>/`,
and shows it at the review. `artifacts:` in the workflow adds names and other paths. There are no
rules: artifacts never block a run, so section 4 (`required`) was dropped. See
`docs/concepts.md`. Still open: a person who adds one at a review (question 7), a blocked Approve
button (question 8), and the prune rule from section 5. Sections 2 to 4 below are the original design.

Mock: `docs/mock/artifacts-review.html`. Open it in a browser. It uses the real app stylesheet, so
only the new parts look new.

## 1. The problem, in today's terms

A review is a `human` step. The runner sets the run to `waiting` and the task to `needs_you` with
`inbox_reason: 'decision'` (`apps/daemon/src/runner.ts:327`). The task page then shows 2 things.

**Overview** shows `DecisionCard` (`apps/web/src/components/Decision.tsx:25`), built by `taskDetail`
(`apps/daemon/src/server.ts:120`): the step's `question`, 1 button per outcome in `step.on`,
`human.artifact` (the **progress entry** of the last agent run, as Did / Decided / Left / Avoid), and
a link "See what it changed (N files) in Chat". The Runs list below repeats each run's progress entry
and the last 30 lines of `runs.output`.

**Chat** shows `GitPanel` (`apps/web/src/components/GitPanel.tsx:27`), fed by `gitView`
(`apps/daemon/src/server.ts:143`) and `gitInfo` (`apps/daemon/src/git.ts:75`):

- **Changes:** `git diff --numstat` against the merge-base, plus untracked files. A click fetches
  `/api/tasks/:id/diff?path=`, a unified diff as **text**.
- **Checks:** every `gate` run; `detail` is the last 8 lines of `runs.output`.
- **Commits:** `git log` since the base.

So the proof of work is 3 kinds of text: a git diff, the tail of a gate's stdout, and the agent's own
4 line self report. For a UI change none of the 3 shows the screen.

**What is absent beyond "a file in the worktree can be read":**

1. No row says *this run made this file, and the review should show it*. The `runs` table holds
   `progress` and `output`, both text (`apps/daemon/src/db.ts:27`).
2. The daemon never serves bytes out of a worktree. The static handler serves `.png`, but only from
   `apps/web/dist` (`apps/daemon/src/server.ts:15`).
3. The UI cannot render an image. `DiffView` parses hunks and says "the file may be binary".
4. The file lives as long as the worktree, and `gitInfo` lists it in Changes as an untracked file
   with a useless line count.
5. The workflow schema has no field for "this step must produce X"
   (`packages/core/src/workflow.ts:25`).

## 2. Three options

### A. Files by convention in the worktree

- **Data model:** none. The daemon reads `<worktree>/.orstra/artifacts/<step-id>/` on request.
- **Bytes:** in the worktree. Add the folder to `.git/info/exclude`, so the user's `.gitignore` stays
  untouched.
- **How a step writes one:** the prompt names the folder. Nothing checks it.
- **Review screen:** a 4th tab in `GitPanel`, plus 2 endpoints: a list, and
  `/api/tasks/:id/file?path=` that sends bytes with a real content type.
- **Cost:** smallest. No schema change.
- **Weak:** no run link (only the file date), no size cap, no way to demand a file, and the files die
  with the worktree.

### B. Declared per step in the workflow file, bytes copied to a store

```yaml
impl:
  use: agent
  prompt: …
  artifacts:
    - name: screen
      path: .orstra/out/*.png
      required: true
```

```sql
CREATE TABLE artifacts (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, run_id TEXT NOT NULL, step_id TEXT NOT NULL,
  name TEXT NOT NULL, label TEXT, mime TEXT NOT NULL, bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL, path TEXT NOT NULL, created_at INTEGER NOT NULL
);
```

- **Bytes:** `~/.orstra/artifacts/<task>/<run>/<name>`, outside the worktree.
- **How a step writes one:** the agent writes the file in the worktree. `Runner.finish` matches the
  globs before it routes the outcome, copies each hit to the store, inserts a row, and records an
  `artifact` event. `buildPrompt` appends 1 line that names the target folder, next to
  `FINISH_INSTRUCTIONS`. A gate step works the same way, so a test report or a log needs no agent.
- **Review screen:** `RunView` gains `artifacts: ArtifactView[]`. `DecisionCard` shows a thumbnail
  strip above the buttons. `GitPanel` gains an Artifacts tab, grouped by run. `/api/artifacts/:id`
  sends the bytes with its `mime`.
- **Cost:** medium. 1 table, 1 schema field, 1 collect step in the runner, 1 endpoint, 2 UI places.
- **Weak:** a glob is a blunt contract. The agent cannot label a file or say what it proves.

### C. A store the agent writes to through Orstra

- **Data model:** the same table, without the glob. The daemon owns the bytes from the start.
- **How a step writes one:** `orstra artifact add out/login.png --label "Login page after the fix"`,
  or the same as an MCP tool. The daemon already has an MCP server for the chief of staff
  (`apps/daemon/src/cos-mcp.ts`). A workflow session does not get it today: `claudeArgs` passes
  `--allowedTools 'Bash Read Edit Write Glob Grep'` and no `--mcp-config`
  (`apps/daemon/src/executors.ts:69`). Orstra would also have to pass `ORSTRA_RUN_ID` and the daemon
  URL into the session environment, which it does not do now.
- **Review screen:** the same as B.
- **Cost:** medium to high. A new tool for the agent, a new session environment, more to get wrong.
- **Strong:** real labels and real intent. The agent says what the file proves.
- **Weak:** a step cannot be **forced** to produce an artifact. There is no glob to check, so the
  absent thing has no name.

## 3. Who takes the screenshot (the agent, not Orstra)

The agent takes it. It has `Bash`, it has the repo, and it already knows how to start that app better
than Orstra ever will. Orstra starts no server, owns no browser and depends on no Playwright.

Orstra owns 3 small things, and nothing else:

1. **One agreed path.** Without it, each run writes `shot.png`, `/tmp/x.png` or nothing, and the
   review cannot find the file. `buildPrompt` appends 1 line that names the folder, the same way it
   appends `FINISH_INSTRUCTIONS` today.
2. **Collect, store, serve, show.** Section 2. This is the real gap: the agent can make a PNG today,
   and still no person sees it at the review.
3. **Say when a declared file is absent.** Section 4.

Expect it to fail in these 4 ways. Each one belongs to the repo, and the fix is a repo script:

- the app needs `npm install`, a `.env`, a database or a seeded user, and the fresh worktree has none;
- `SLOTS` defaults to 4 (`apps/daemon/src/paths.ts:17`), so 4 worktrees of one repo fight over port 3000;
- the machine has no headless browser, and the agent downloads 200 MB mid-run or gives up;
- the dev server outlives the run and leaks, because Orstra tracks no child process of a session.

So the repo should declare 1 command, such as `screenshot: npm run shot -- --out .orstra/out`. A
`gate` step runs it, the exit code routes the outcome as usual, and the collector picks up the file.
A repo with no such command gets no screenshot, and that gap belongs to the repo.

## 4. Can a step be forced to produce an artifact?

Yes, with `required: true` in Option B. 3 behaviours are possible when the file is absent:

| Behaviour | What happens | Verdict |
|---|---|---|
| Hard fail | the run ends `cant_do` and the task goes to the Inbox | too harsh for a soft signal |
| One retry, then you | the runner notes "Attempt 2. The step must write `<glob>`." and queues the step again; a second miss goes to the Inbox | **pick this** |
| Warn only | the review card says "No artifacts from this step" | the default without `required` |

- An absent file is never silent. The review card states it either way.
- Do not add a `missing_artifact` outcome. Every workflow would need an arrow for it, and `route`
  already sends an unmatched outcome to the Inbox (`packages/core/src/route.ts`).
- A person can still approve with no artifact. Orstra shows the gap; it does not block you.

## 5. Size, retention and the end of a worktree

- **Store, not database.** Keep the bytes as files under `~/.orstra/artifacts/`. `node:sqlite` holds
  one file at `~/.orstra/orstra.db`; blobs would grow it without limit.
- **Caps.** 10 MB per file, 50 MB per run. Over the cap, Orstra skips the file and keeps the reason
  in the row's `label`, so the review says why nothing is there.
- **Kinds.** Render PNG, JPEG, WEBP and SVG inline. Show text, Markdown and JSON in a `<pre>`. Offer
  every other type as a download.
- **The worktree.** Nothing in Orstra removes a worktree today, and `stop` keeps it on purpose. A
  person who runs `git worktree remove` by hand deletes whatever lives only there. The copy out of
  the worktree is the whole point of Option B.
- **Task close.** Keep the artifacts; a closed task is the one you look back at. Delete a task's
  folder with the task, prune closed tasks after 30 days, and show the total size in Settings.
- **Git.** Never commit an artifact into the user's branch. It would then appear in the PR.

## 6. The word: "artifact"

Use **artifact**. It is the plain word for a file a step makes, a workflow author expects
`artifacts:` in YAML, and this note is already called `step-artifacts.md`.

- **"attachment" is wrong.** It sounds like a file a person adds to a message, as in email. It says
  nothing about the step that made it.
- **"evidence" is sharper but narrow.** It fits a screenshot at a review. It fits a plan document or
  a build log less well, and those are artifacts too. The narrower word would need a second word
  later.

The word costs 1 small rename, because `human.artifact` is taken:

| Place | Today | Change to |
|---|---|---|
| `apps/daemon/src/server.ts:120` | `artifact: { step, progress }` | `subject: { step, progress }` |
| `apps/web/src/api.ts:63` | `HumanDecision.artifact` | `HumanDecision.subject` |
| `apps/web/src/components/Decision.tsx:68` | `human.artifact` (3 uses) | `human.subject` |
| `docs/design.md:29` | "shows the artifact being decided" | "shows what it decides about" |

`human.artifact` is the **subject of a decision** (the last agent run's progress entry), not a file.
No UI string shows the word, so the rename is invisible to you. Do it in the same change, before the
new meaning arrives, or the 2 senses live side by side and `docs/concepts.md` loses its "one word for
one meaning" rule.

One risk remains: in CI, "artifact" means build output, caches and deployables. State in
`docs/concepts.md` that an Orstra artifact is **a file a run produces, kept for you and for later
steps**, and that Orstra caches nothing and deploys nothing.

## 7. Recommendation

Take Option B. Add an `artifacts` table and an `artifacts:` field per step, collect the matched files
in `Runner.finish` before the outcome routes, copy them to `~/.orstra/artifacts/<task>/<run>/`, and
serve them from `/api/artifacts/:id` with a real content type. Show them in 2 places: a thumbnail
strip in `DecisionCard`, between the question and the comment box, and an Artifacts tab in `GitPanel`
grouped by run. The agent keeps the screenshot job: the repo declares 1 command, a `gate` step runs
it, and Orstra only collects the file. Build `required: true` with the retry-once rule from section 4
and the caps from section 5. Rename `human.artifact` to `human.subject` in the same change. Add
Option C later, as a label on top of the same table, once workflow sessions get the Orstra MCP
server for other reasons.

## 8. Overlap with task t-mwt4oo (workspace or project)

1. **Where the repo level commands live.** "How do I start this app" and "how do I take a screenshot"
   belong to a project row, not to `workflows/*.yaml`. Option B needs no such field, so it can come
   first and read the command later.
2. **The path layout under `~/.orstra`.** This note proposes `~/.orstra/artifacts/<task>/<run>/`. With
   a project row the root may become `~/.orstra/<project>/artifacts/<task>/…`. The row keeps `path` as
   a stored value, so a move is a migration, not a redesign.
3. **Whose settings hold the caps and the prune rule.** Global today, per project later. Keep the row
   keyed by `run_id` only and derive the project from the task. Then no column changes when that task
   settles its model.

## 9. Questions for you

1. **The rename.** Is `human.subject` the right new name for today's `human.artifact`? `about` and
   `basis` also work.
2. **Lifetime.** Must an artifact outlive the worktree? A "no" makes Option A enough and halves the
   work.
3. **The agreed path.** Is `.orstra/out/` the folder, and does `buildPrompt` name it in every agent
   prompt? Or only in the steps that declare `artifacts:`?
4. **`required: true`.** Is "one retry, then the Inbox" right for an absent file?
5. **Caps and prune.** Are 10 MB per file, 50 MB per run and 30 days right?
6. **An artifact as an input.** Must a later agent step read an artifact of an earlier step, for
   example "look at the screenshot and judge it"? That decides whether the paths enter `buildPrompt`.
7. **You, as a producer.** May a person add an artifact at a review, such as a pasted screenshot?
   Then "attachment" comes back as a second word, for the files you add.
8. **Blocked approval.** May a review step hide the Approve button until an artifact exists?
