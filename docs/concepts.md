# Orstra concepts

The words Orstra uses, what each one means, and where it lives in the app. If code, UI copy and this page disagree, this page wins; fix the other two.

## The short version

- A **workflow** is a recipe. A **trigger** starts it.
- Each time it starts, you get a **task**: one piece of work, like Linear ticket HUB-416.
- The task moves through the workflow's **steps**. Each time a step executes, that's a **run**.
- An agent run is one **session**: a conversation with Claude Code or Codex.
- When a run ends it has an **outcome**, which picks the next step, and a **progress entry**, which tells the next run what happened.

```
Trigger ──starts──▶ Task ──follows──▶ Workflow
                     │                  └─ Steps (agent · gate · human · switch · action)
                     │
                     └─ Runs (one per step execution, retries included)
                          └─ Session (agent runs only: the Claude Code / Codex conversation)
```

## Definitions

### Workflow
A reusable recipe, written as a YAML file: a list of steps and the arrows between them. "Linear ticket → PR" is a workflow. It does nothing on its own until a trigger (or you) starts a task with it.

- Lives in `~/.orstra/workflows/*.yaml`.
- Edited on the **Workflows** screen (the canvas) or as YAML. Both edit the same file.

### Step
One node in a workflow. Each step has a kind:

| Kind | What it does | Ends with |
|---|---|---|
| `agent` | An agent (Claude Code, Codex) works on a prompt | `done`, `needs_you`, `cant_do` |
| `gate` | Runs shell commands, such as tests | `pass`, `fail` |
| `human` | Waits for your decision | one outcome per choice (`approved`, `changes_requested`, `rejected`, …) |
| `switch` | Picks a branch from the task's data | the matching case |
| `action` | Runs one named action: `git.merge`, `github.pr` or `git.cleanup` | `ok`, `error`, `conflict`, `nothing`, `refused` |

Arrows say where each outcome goes. Backward arrows (retries) must have a cap: `{ goto: impl, max: 3 }`.

Any agent or gate step can also end with `timeout` (it worked longer than its `timeout:` in minutes) and an agent step with `over_budget` (the task reached the workflow's `budget_usd`). With no arrow for them, the task goes to your Inbox.

### Trigger
What starts tasks automatically. Examples: a Linear issue labeled `agent-ready`, a schedule, a GitHub PR comment, a file change. One trigger points at one workflow and creates one task per matching event. You can also start a task by hand.

### Task
**The unit of work you care about.** One task = one thing going through one workflow, usually one ticket: "HUB-416 · Empty state on the Trending page".

- A task has a status: **running**, **needs you**, **done** or **stopped**.
- **Done is the end of a workflow, never a step.** A workflow asks you once (In review), and a done task waits for nothing. To ask for more work, press **Reopen** on the done task: its first agent step runs again with what should change, and you review it once more.
- A task keeps everything across its whole life: its worktree and branch, its runs, its progress entries, your notes and decisions.
- A task has exactly **one home: the task page.** Every list in the app links there.

### Run
**One execution of one step for one task.** A task has many runs.

- "Implement" running for the first time is run 1. If tests fail and it comes back, that's run 2 ("attempt 2"). Retries are always new runs.
- A run has a status (queued, running, waiting, done, failed, stopped), an outcome when it ends, and a progress entry.
- **Task vs run:** the task is *what* is being done (HUB-416). Runs are *the individual steps taken* to do it (Reproduce bug → Implement #1 → Tests #1 → Implement #2 …). You track tasks; you look at runs when you want to know what happened inside one.

### Session
**The agent conversation behind an agent run.** One agent run = one Claude Code (or Codex) session, with its own session id.

- Every run starts a **fresh** session. It knows the earlier runs only through their progress entries, the worktree and git.
- You **chat** with a session while it runs: your message goes straight in, and Stop interrupts it. If it asks you something, it waits open for your reply.
- After a run ends, you can **reopen** its session to keep talking (same history). While the task is still open, your message **sends that step back** to the agent: it gets a new run (next attempt) on the same session, so the round keeps its own progress entry and its outcome moves the task again. Anything that waited on you closes, because a decision must never stand while the agent changes the diff.
- A task you finished or stopped never comes back from a message. The session answers you and the task stays where it is; re-run a step to start work again.
- **Open in Claude Code** shows the same session in your terminal. Both windows are one session.
- **Side chat** asks a copy of the session (a fork). The copy answers in the Side chat panel of the viewer. The run is not touched, and the task does not move.
- Gate, human, switch and action runs have no session.

### Outcome
How a run ended (`done`, `pass`, `fail`, `approved`, `needs_you`, …). The outcome picks the arrow to the next step. No matching arrow, a used-up retry cap or `needs_you` sends the task to your Inbox. Nothing is ever silently stuck.

### Progress entry
What a run did, written when it ends: **Did · Decided · Left · Avoid**. It is how work passes between fresh sessions, and it's mirrored to the ticket (e.g. as a Linear comment).

### Artifact
**A file a step produces, kept for the steps after it and for your review.** A plan, a report, test output, a log, a picture. Any agent or gate step makes one the same way: it writes the file under `.orstra/artifacts/` in the worktree. No workflow change is needed.

1. **Keep.** When a run ends, Orstra copies every new file under `.orstra/artifacts/` to `~/.orstra/artifacts/<task>/<run>/`, outside the worktree, and records which run made it. A file left there unchanged is not kept twice.
2. **Hand on.** Before each agent or gate run, Orstra puts the newest kept files of every earlier step at `.orstra/inputs/<step>/<file>`. The agent's prompt lists them, a gate command can read them, and a workflow prompt can name them with `{{ steps.<step>.artifacts }}`.
3. **Review.** The decision card shows what the steps made since your last decision. Each run on the Overview shows its own, and the Changes panel has an Artifacts tab for the whole task.

A step can also declare files it must leave, at any path:

```yaml
plan:
  use: agent
  prompt: Write the plan to .orstra/artifacts/plan.md
  artifacts:
    - name: plan
      path: .orstra/artifacts/plan.md
      required: true
```

- `required: true`: no file means the step runs once more, then the task waits for you (`missing_artifact`). A declared file that never arrived is recorded, so the review states the gap.
- Images and text show inline; anything else is a download. 10 MB per file, 50 MB per run.
- `.orstra/` stays out of git (`.git/info/exclude`), so artifacts never reach your branch or the PR.
- **Orstra never makes an artifact.** The step does, with its own tools; Orstra keeps it, hands it on and shows it.

### Note
Something you write **on a step that hasn't run yet**, for its next run to read ("also run the e2e suite"). A note is never sent to a running agent. To talk to a running agent, chat with its session.

### Attachment
A file **you** add to a chat message: a screenshot you paste, a log you drop, a PDF you pick. It works the same in a task's chat and in the assistant's chat. Orstra writes the file into the folder that chat's agent works in, and puts its path at the end of your message, so the agent can open it.

| Chat | Folder | Kept out of git by |
|---|---|---|
| A task's session | `<worktree>/.orstra/attachments/<id>/` | the repository's own exclude file, never your `.gitignore` |
| Assistant | `~/.orstra/cos/attachments/<id>/` | no git there at all |

The caps are 10 MB per file and 25 MB per message; over them, Orstra tells you and attaches nothing.

An attachment is a file **you** add. A file a **step** produces is an **artifact**. One root, 3 folders: `.orstra/attachments/` (yours), `.orstra/artifacts/` (what a step keeps) and `.orstra/inputs/` (what the earlier steps kept, put there for the next run).

### Claude artifact
A web page an agent publishes to your claude.ai account with Claude Code's `Artifact` tool. It is not Orstra's artifact above: it lives on claude.ai, not in the worktree. A step's agent writes an HTML file, publishes it, and prints the link in its message. Orstra stores nothing about it. Turn it off with `"artifact": false` in `~/.orstra/agents.json` (Settings → Agents), or `ORSTRA_CLAUDE_ARTIFACT=0`.

Its limits:

- It needs a paid Claude plan and a claude.ai login. A session that signs in with `ANTHROPIC_API_KEY`, a gateway token or a cloud provider cannot publish.
- A step's agent runs `claude -p`, which holds no live watch, so the page gets no live update subscription.
- A republish of the same file path keeps the same URL, so the agent can correct a page without a second link.

### Viewer
The panel on the right of a task's Chat view, in the Inbox pane too. It starts closed, so the chat has the room: a reference, a shortcut or the button at the top right opens it. It shows what the agent's messages name, and the tools around the worktree, in tabs:

- **References.** Orstra finds web links, Claude artifacts, a local dev server URL, and paths to `.md` and image files in each agent message. Each one shows as a chip under the message. A click opens it in a tab. A site that refuses frames (most do, claude.ai too) shows as a card with an Open button.
- **Panels**, from the + menu: Changes (branch, files with diffs, checks, commits), Browser (Orstra starts the worktree's dev server and shows its page), Files (the worktree as a tree, read-only), Terminal (a real shell in the worktree), Side chat, and Artifacts (what the task's agents made).
- **Layout.** 2 panes at most, side by side or stacked. Right-click a tab to split, move or close it. Expand (⌘\\, or a double-click on a tab) puts the viewer over the chat. Drag the viewer's left edge to change its width, and the line between 2 panes to change their share; a double-click resets either. Otherwise the chat keeps 380 px or more.

Shells and dev servers end when the daemon stops, and before a cleanup removes the worktree.

### Decision
Your answer at a `human` step. You see what you're deciding (e.g. the spec, the agent's assumptions and open questions) and what each choice leads to. Each choice is an arrow.

### Worktree
The task's own working copy: `git worktree` on branch `orstra/<task>`. All of a task's runs work in it, one after another.

### Merge
The `git.merge` action. Put it in a workflow where the work should land: it merges the task's branch into the branch the repository has checked out. The Simple workflow merges nothing; its work stays on the task's branch.

- Local only. It never pushes, and it never forces a merge.
- It does nothing when the task branch has no new commit, or when the task has its own scratch repository (a task started without a repo).
- It refuses to start when the main checkout has uncommitted changes. The task goes to the Inbox and tells you to commit or stash them.
- On a conflict it runs `git merge --abort`, so the repository is as it was, and the task goes to the Inbox.
- The worktree and the branch are kept either way, so the task's diffs and any uncommitted work stay readable. Remove them by hand when you are done: `git worktree remove <path>`.

### Pull request
The `github.pr` action. It pushes the task's branch (never with force) and opens a draft pull request with the GitHub CLI. Its body holds the ticket, the task's description and every progress entry. If a pull request is already open for the branch, it pushes the new commits to it. The task page links to it.

### Cleanup and archive
When a task is done or stopped, **Archive** takes it out of the lists. **Clean up** also removes its worktree, and its branch when your checked-out branch already has every commit. Clean up refuses, and changes nothing, when the worktree has uncommitted work or the task has its own scratch repository; you can then choose to throw that work away. The `git.cleanup` action does the same as a workflow step; put it last.

### Permission question
A Claude Code tool call that the agent's permission mode does not allow. Orstra puts it in your Inbox: **Allow once**, **Allow for this task** (later calls of that tool pass), or **Refuse** with a reason the agent reads. The run waits, and its timeout clock stops, until you answer. Turn this off in Settings to have Claude Code refuse such calls.

### Budget
`budget_usd` on a workflow: when a task's runs cost that much (Claude Code's own estimate), Orstra starts no more agent work for it, and the task goes to your Inbox. Codex reports tokens but no cost, so a budget does not count Codex runs.

### Agent
A coding CLI Orstra can drive: Claude Code or Codex (`agent: codex` on a step). Configured in Settings (model, effort, permission mode, permission questions). Codex runs `codex exec` in a workspace-write sandbox; each message is a new turn on the same Codex thread.

### Slot
How many runs can work at the same time on this machine (default 4). Agent and gate runs take a slot; human, switch and action runs don't. When all slots are busy, new runs wait as **queued**.

### Assistant
**One ongoing conversation with an agent that sees every task.** It briefs you, answers questions about any task, and acts for you through Orstra: it messages a task's agent, leaves notes, starts, retries or stops tasks, answers decisions, and **watches** tasks to follow up later ("retry HUB-405 when HUB-432 is done").

- It is Claude Code with Orstra's tools **and** its own: Bash, Read, Edit, Write, the web tools, and whatever else Claude Code gives your machine. So it can read a file, change a file and run a command itself. Nothing limits it: no tool list, no path check, no permission question. Its working folders are `~/.orstra` (the database, the workflow files, every task worktree) and the Orstra checkout, and those are where it works, not a fence. It can reach any path you can.
- It opens a file you **attach** to a message the same way, by the path Orstra puts at the end of your message. That folder, `~/.orstra/cos/attachments/`, is inside its workspace.
- **Orstra, not the model, decides what needs your OK** for Orstra's own actions. This is a guard against mistakes, not a fence: the assistant also has Bash with no permission check, so it could call the daemon's API or edit the database itself. Its prompt tells it not to. Actions that need it become a **plan**: a card with Do it / Not now. Messaging agents is allowed by default; starting and retrying tasks asks by default; decisions and stopping always ask.
- **A file or a command of its own has no plan card and no review step.** Work on a task still belongs to the task's agent: only then does the change land on the task's branch and go through the workflow. Ask it for a small fix or a quick look; ask a task for the work.
- Everything it does through Orstra's tools is recorded on the task, marked as done by your assistant. Its own files and commands show in the conversation only.
- **It says the result first.** A card is 1 line that names the task by its ticket or title; the instruction or the message it sent folds under Details. A long reply shows its first 2 paragraphs and folds the rest. When a reply names a task that waits for you, a button opens it.

## Screens (one home per concept)

| Screen | Shows | Clicking an item |
|---|---|---|
| **Assistant** | The conversation, its plans waiting for your OK, what it is watching, what it may do without asking | Task rows open the task page |
| **Tasks** | All tasks, in 3 views. **Inbox**: the tasks that need you (a decision, a question from an agent, a stuck task), across every workflow, with the selected task open beside the list. **Board**: one workflow's tasks by their current step (columns = workflow steps). **List**: all tasks by status | Inbox: opens the task in the pane. Board and List: open the task page |
| **Task page** | One task: its steps (with notes), the decision if one is waiting, and the chat with its sessions and the viewer | A chip under an agent message opens it in the viewer |
| **Workflows** | The workflow editor (canvas or YAML) | Edits a workflow |
| **Settings** | Agents, triggers, repositories, connections, notifications | — |

**Rules for the UI:**
- **One home per object.** Tasks live on the task page, workflows on Workflows, agents and triggers in Settings. Lists only navigate; they never offer a second place to act. Two exceptions: the Inbox view shows the task page itself in a pane beside the list, so acting there is acting on the task page; and the assistant, which you can ask to act, and which shows every action as a plan or a receipt that links to the task.
- **No list → list links.** From any list you go to the task page and back, never to another list.
- **Talking and notes never mix.** Chat goes to a session; notes go on a step.

## Words we don't use

| Avoid | Say instead | Why |
|---|---|---|
| "Session page" for a task | Task page | A task has many sessions |
| "Steer" | Chat / message | It's just talking to the live session |
| "Job", "pipeline", "execution" | Run / workflow | One word per concept |
| "Evidence", "output file" | Artifact | One word for a file a step produced |
| "Board" as a separate place | Tasks (board view) | It's a view of tasks, not its own thing |
| "Attachment" for a file a step makes | Artifact | You add an attachment; a step produces an artifact |
