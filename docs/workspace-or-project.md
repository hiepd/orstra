# Workspace or project: how a task gets a repo

A design note. **Decided and built:** Option A, named **workspace** (the user's choice over this note's "project"). See "Workspace" in [concepts.md](concepts.md) for what shipped. The rest of this note is the reasoning as it was written; its line numbers are from before the build.

## 1. The problem, in the words the code uses now

What exists today:

- `Workflow` has an optional `repo` field (`packages/core/src/workflow.ts:81`).
- `StartTaskInput` has an optional `repo` field (`apps/daemon/src/runner.ts:20`).
- `Runner.startTask` calls `createWorktree(taskId, input.repo ?? wf.repo)` (`apps/daemon/src/runner.ts:264`).
- `createWorktree` (`apps/daemon/src/worktree.ts:10`) has 2 modes. With a repo it runs `git worktree add -q <dir> -b orstra/<task>`. Without a repo it runs `mkdir` and then `git init -q -b main`.
- The task row keeps only the result path, in `tasks.worktree` (`apps/daemon/src/db.ts:22`). It does not keep the repo, the base branch, or a sub-directory.
- Every agent run and every gate run uses `task.worktree` as its `cwd` (`apps/daemon/src/runner.ts:421` and `:701`).

Why t-mwt4a4 got an empty repo:

1. The Assistant (then called the chief of staff) started the task. Its `start_task` tool has no `repo` parameter (`apps/daemon/src/cos-tools.ts:56`).
2. The task used the `Simple` workflow. `~/.orstra/workflows/simple.yaml` has no `repo:` key.
3. So `repo` was `undefined`. `createWorktree` took the `git init` branch.
4. The agent opened an empty folder, found no code, and stopped.

"No repo" is not an error today. It is a supported mode with its own UI copy: `apps/web/src/pages/Workflows.tsx:90` says "no repository: each task gets its own scratch folder".

Two more gaps in the same area:

- There is no base branch anywhere. `git worktree add -b orstra/<task>` with no start point branches from the main checkout's current HEAD. The result depends on the branch the user left the repo on.
- `baseOf` (`apps/daemon/src/git.ts:67`) reads the main checkout's HEAD at read time. If the user switches branch in the main checkout, the task's diff base moves under it.

The missing concept: nothing binds a task to a repo, a base branch, and a working directory. The repo is a property of the workflow, so 1 workflow cannot serve 2 repos, and a task cannot name its own.

## 2. Options

### Option A: a project row, 1 repo per project

**Data model.** New table `projects`: `id`, `name`, `repo_path`, `base_branch`, `subdir` (nullable), `default_workflow` (nullable), `created_at`. `tasks` gets `project_id`. `tasks.worktree` stays as it is.

**Start flow.** `StartTaskInput` takes `projectId` in place of `repo`. Resolution order: the input, then the workflow's `project:`, then the only project if just 1 exists, else an error. `createWorktree` runs `git worktree add <dir> -b orstra/<task> <project.base_branch>`. The agent `cwd` becomes `join(worktree, project.subdir ?? '')`.

**UI.** Projects gets its own sidebar item, between Tasks and Workflows, not a place in Settings, so people can find it. Each project has a home page with 2 tabs: Overview (counts, active tasks, where the code is) and Settings (create, edit, delete). The New task modal replaces the free-text "Repo path" field with a project picker. Task rows and the task page show a project badge. A workflow may name a default project.

**Cost.** 1 table, 1 column on `tasks`, 1 picker. `repo:` in workflow YAML can stay as a shorthand that resolves to a project.

### Option B: a project row, many repos per project

**Data model.** `projects` (`id`, `name`) plus `project_repos` (`project_id`, `name`, `repo_path`, `base_branch`, `subdir`, `primary`). `tasks.project_id`. `tasks.worktree` becomes a parent folder. Each repo gets its own sub-folder below it.

**Start flow.** `createWorktree` loops over the project's repos. It creates `~/.orstra/wt/<task>/<repo-name>` for each one, all on branch `orstra/<task>`. The agent `cwd` is the parent folder, so 1 session sees every repo.

**UI.** As Option A, plus a repo list inside a project. The worktree panel needs a repo selector, because the branch, the diff and the commits are per repo now. `gitInfo` and `gitDiff` take a repo, not just a directory.

**Cost.** The highest. The git panel, `gitInfo`, `gitDiff`, the base calculation, and the future PR action step all become per repo.

### Option C: no new object, the repo moves onto the task

**Data model.** `tasks` gets `repo`, `base_branch` and `subdir`. No new table. Settings keeps a list of known repo paths in a `kv` row, only to fill the picker.

**Start flow.** `startTask` needs a repo. If neither the caller nor the workflow gives one, the task does not start, and the error names the fix. The Assistant's `start_task` gets a `repo` parameter.

**UI.** The New task modal keeps its repo field, now a dropdown plus a base branch field. No Projects screen.

**Cost.** The lowest. It fixes the empty worktree. It gives no home to per-project defaults, such as setup commands, the default workflow, or the PR target.

## 3. How other tools do this

I checked 6 tools. Each row below comes from the tool's own docs or its files on this machine. See the sources at the end.

| Tool | Long-lived object | Per-task object | Repos per object | Base branch | Setup config lives in |
|---|---|---|---|---|---|
| Superset | **project** | **workspace** (a git worktree) | 1 | from the checkout | `.superset/config.json` in the repo, with `setup`, `teardown`, `run` and an optional `cwd` |
| Conductor | **repository** | **workspace** (a git worktree, 1 per task, own branch) | 1 | from the repo | the app's settings per repository, not repo files |
| Jules | the connected **repo** | task (a virtual machine) | 1 | picked per task, default branch preselected | per-repo environment setup scripts |
| Codex Cloud | **environment** | chat (a container) | 1 | picked per task as a branch or a commit SHA | environment settings: setup script, maintenance script, variables, secrets |
| Devin | **environment**, built as a blueprint into a snapshot | session (a copy of the snapshot) | **many** | per session | the blueprint, 1 active snapshot per platform per org |
| Claude Code (local) | **project**, which is 1 absolute directory | session | 1 | none | the `projects` map in `~/.claude.json`, keyed by path |

6 lessons:

1. **Every tool has 2 objects, not 1.** There is a long-lived object for the repo and its setup, and a throwaway object per task. Orstra already has the second one, the worktree. It is missing the first one. No tool does this with 0 objects.
2. **Nobody calls the long-lived object a workspace.** Superset and Conductor both use "workspace" for the per-task worktree, which Orstra calls a worktree. So "workspace" for the new object would clash with the 2 nearest tools as well as with the elezar platform app.
3. **The base branch is a per-task choice with a default.** Codex takes a branch or a commit SHA per chat. Jules preselects the repo's default branch and lets you change it. Neither hard-codes 1 branch per repo. This changes the answer below: the project holds the default, and the task records what it resolved to.
4. **Per-repo setup is standard, not a luxury.** All 6 have it: setup commands, environment variables and secrets. Conductor adds "files to copy" for gitignored files such as `.env.local`, because a fresh worktree does not have them. Orstra will hit this on the first real repo.
5. **1 repo is the norm. Many repos is the exception.** Superset, Conductor, Jules and Codex all bind 1 repo. Only Devin holds many, and it pairs that with a container snapshot, not a worktree. Superset covers the monorepo case with `cwd`, which is the sub-directory idea in Option A.
6. **The 2 tools own setup differently.** Superset puts it in the repo, so a team shares it. Conductor keeps it out of the repo, on the Mac, and its docs tell the agent not to write settings files. Orstra is local and single-user today, so the database is enough. A `.orstra/config.json` in the repo stays open for later.

I could not verify Cursor's wording, because its docs render in the browser and return no text to a plain fetch. I left it out rather than guess.

## 4. Open points to settle

- **1 repo or many.** Option A assumes 1. Lesson 5 supports that. The monorepo case is already covered by 1 repo plus a sub-directory, because `apps/daemon`, `apps/web` and `packages/core` share 1 repo.
- **Where the base branch comes from.** Lesson 3 settles the shape: the project holds a default base branch, and the New task form lets you change it per task. The open part is the default itself. Read `origin/HEAD`, or store a fixed name? Today's behaviour, the main checkout's current HEAD, is the 1 choice to drop.
- **The moving diff base.** Should the task row keep the start commit, so `baseOf` stops reading the main checkout at read time?
- **No project at start.** 3 choices: refuse and say why; fall back to the scratch repo as now; ask the user through the Inbox. The Assistant cannot pass a repo at all today, so it needs the new field or a default project.
- **Sub-directory.** Does a project point at the repo root or at a path inside it? A sub-directory is cheap for the agent `cwd`. It is not cheap for git, because the branch and the diff stay repo-wide.
- **Tasks that exist now.** 2 tasks exist. Both sit on scratch repos. 3 choices: leave them with a null project; delete them; backfill a project by hand. The data is 1 day old.
- **Per-project setup.** Lesson 4 says yes: setup commands, environment variables, and a list of gitignored files to copy. The open part is the order. Ship the project first and setup later, or both at once? A worktree with no `node_modules` and no `.env` is the next failure after this one.
- **Is the scratch mode worth keeping?** Research tasks and the Assistant's own folder (`~/.orstra/cos`) have no repo. Option A can model that as a project with no repo, or keep the fallback for tasks with no project.
- **Do the views split per project?** Answered below.

### The views stay across projects

A project filters the lists. It never scopes them, and there is no current project.

4 reasons, all from Orstra's own code:

1. **The slot pool is machine-wide.** `SLOTS` is 4 (`apps/daemon/src/paths.ts:19`), and `pump()` counts busy runs across every task (`apps/daemon/src/runner.ts:323`). A workflow's `concurrency` field is parsed but never enforced. So "what runs now" and "why is my task queued" are global facts. A per-project list hides the task that holds the slot.
2. **The Assistant already sees every task** (`docs/concepts.md:145`). If the Tasks view scoped itself to 1 project, the 2 would disagree about the word "every".
3. **The Inbox is attention, and attention is global.** The Inbox is now a view inside Tasks, so a scoped Tasks page would scope it too. 3 projects would mean 3 inboxes to remember. That breaks "calm by default" (`docs/design.md:11`).
4. **The scale is small.** 1 user, 1 machine, no team (`docs/design.md:16`). A handful of projects and a few tens of tasks do not need partitions.

1 exception: the board's columns come from 1 workflow (`docs/concepts.md:160`). That stays true. The workflow picks the columns, and the project filters the rows. The 2 filters are independent.

A default project is still worth it, but only where a task is created: the New task form and the Assistant's `start_task`. Use the project of the last started task. A default that only fills a form field cannot mislead you. A current project that scopes the views can: you read an empty list, you believe the work is done, and 3 tasks run in another project.

UI, then: a project badge on task rows and in the Inbox, a project filter on Tasks, "group by project" beside "group by status", and a project picker in the New task form. No project switcher in the sidebar.

## 5. The name

**Recommendation: project.**

The evidence in section 3 decides this.

1. **The 2 nearest tools already use "workspace" for the worktree.** Superset creates a workspace per task as an isolated git worktree. Conductor says "each task gets its own workspace, branch, files, terminal, diff, and review path". Orstra calls that a worktree (`docs/concepts.md:115`). If Orstra uses "workspace" for the new object, it means the opposite of what both tools mean.
2. **The elezar platform app owns the word too.** `PRODUCT.md:9` uses "workspace" for the shared tenant that holds threat profiles, hunts and users. The same person reads both products.
3. **npm uses it for a package folder in this repo.** `README.md:10` runs `npm run dev --workspace @orstra/web`. Codex steps also run in a `workspace-write` sandbox (`README.md:89`).
4. **"Project" has precedent for exactly this object.** Superset's project is the repo registration a workspace is created from. Claude Code's own `~/.claude.json` keeps a `projects` map keyed by absolute directory. Both mean "the long-lived code location", which is what Orstra needs.

The 1 cost of "project": Linear, the ticket source Orstra points at, uses "project" for a group of issues. That is a near meaning, not a conflict, because Orstra's project is the code and Linear's project is the plan. State this in `docs/concepts.md`.

1 cost in the code: `apps/daemon/src/project.ts` and `projectTask` already mean "projection", the writer of a task's state. Rename that file to `projection.ts` before a `projects` table arrives, or every reader will confuse the 2.

"Repository" is the honest alternative, and Conductor uses it. It is the better name only if the object never holds more than a path, which is Option C. `docs/concepts.md:163` already lists "repositories" in Settings.

## 6. Recommendation

Take Option A, and call it a project. Add 1 `projects` table with 1 repo per project, a `default_base_branch` field, and an optional `subdir`, then add `project_id` to `tasks`. Every tool I checked has this object, under 1 of 4 names, so the question is the name and the size, not whether to have it. It fixes the real failure, because a task can name its repo and the Assistant can pass a project id. It gives per-project setup a home, which Option C does not, and setup is the next failure after this one. It leaves the git code alone, because 1 worktree still means 1 repo, which Option B would break. 2 changes from my first draft, both from the evidence: the base branch is a project default that the task may override, not a fixed field, and the task records the commit it started from, so the diff base stops moving. Make a project required for a new task, and delete the silent `git init` fallback: the empty scratch repo is the bug, not a feature. Leave many repos per project for later. Only Devin does that, and it pairs it with snapshots instead of worktrees.

## 7. Questions for you

1. Option A, B or C?
2. Does any task you plan need 2 repos at the same time?
3. The default base branch: read `origin/HEAD` at start time, or store a fixed name per project? Either way the task may override it.
4. A task starts with no project. Refuse, or fall back to a scratch repo? I propose refuse.
5. Does a project hold a sub-directory, or always the repo root?
6. "Project" or "workspace"? I propose project, and the evidence is 1-sided.
7. The 2 tasks that exist now: leave them with a null project, or delete them?
8. Setup commands, environment variables and files to copy: in the project now, or later? Your answer sets how big the first version is.
9. Do you accept that the views stay across projects, with the project as a filter and as the default for a new task only?

## Sources

- Superset: `~/.claude/skills/superset/skills/setup/SKILL.md` and `skills/10x/SKILL.md` on this machine.
- Conductor: https://conductor.build/docs and https://conductor.build/docs/configure-your-project
- Jules: https://jules.google/docs
- Codex Cloud: https://developers.openai.com/codex/cloud/environments
- Devin: https://docs.devin.ai/onboard-devin/repo-setup
- Claude Code: `~/.claude.json` on this machine, 26 entries in its `projects` map, each keyed by an absolute directory.
- Orstra and elezar line numbers: the repos at `~/workspace/orstra` and `~/workspace/elezar/platform`.
