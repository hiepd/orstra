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
| `action` | Runs one named action, such as `git.merge` | `ok`, `error`, `conflict` |

Arrows say where each outcome goes. Backward arrows (retries) must have a cap: `{ goto: impl, max: 3 }`.

### Trigger
What starts tasks automatically. Examples: a Linear issue labeled `agent-ready`, a schedule, a GitHub PR comment, a file change. One trigger points at one workflow and creates one task per matching event. You can also start a task by hand.

### Task
**The unit of work you care about.** One task = one thing going through one workflow, usually one ticket: "HUB-416 · Empty state on the Trending page".

- A task has a status: **running**, **needs you**, **done** or **stopped**.
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
- After a run ends, you can **reopen** its session to keep talking (same history). That doesn't move the task.
- **Open in Claude Code** shows the same session in your terminal. Both windows are one session.
- Gate, human, switch and action runs have no session.

### Outcome
How a run ended (`done`, `pass`, `fail`, `approved`, `needs_you`, …). The outcome picks the arrow to the next step. No matching arrow, a used-up retry cap or `needs_you` sends the task to your Inbox. Nothing is ever silently stuck.

### Progress entry
What a run did, written when it ends: **Did · Decided · Left · Avoid**. It is how work passes between fresh sessions, and it's mirrored to the ticket (e.g. as a Linear comment).

### Note
Something you write **on a step that hasn't run yet**, for its next run to read ("also run the e2e suite"). A note is never sent to a running agent. To talk to a running agent, chat with its session.

### Attachment
A file **you** add to a chat message: a screenshot you paste, a log you drop, a PDF you pick. It works the same in a task's chat and in the chief of staff's chat. Orstra writes the file into the folder that chat's agent works in, and puts its path at the end of your message, so the agent can open it.

| Chat | Folder | Kept out of git by |
|---|---|---|
| A task's session | `<worktree>/.orstra/attachments/<id>/` | the repository's own exclude file, never your `.gitignore` |
| Chief of staff | `~/.orstra/cos/attachments/<id>/` | no git there at all |

The caps are 10 MB per file and 25 MB per message; over them, Orstra tells you and attaches nothing.

An attachment is a file **you** add. A file a **step** produces is an **artifact** (not built yet). One root, 2 folders: `.orstra/attachments/` and `.orstra/artifacts/`.

### Decision
Your answer at a `human` step. You see what you're deciding (e.g. the spec, the agent's assumptions and open questions) and what each choice leads to. Each choice is an arrow.

### Worktree
The task's own working copy: `git worktree` on branch `orstra/<task>`. All of a task's runs work in it, one after another.

### Merge
The `git.merge` action, the last step of the Simple workflow. When you close a task, it merges the task's branch into the branch the repository has checked out.

- Local only. It never pushes, and it never forces a merge.
- It does nothing when the task branch has no new commit, or when the task has its own scratch repository (a task started without a repo).
- It refuses to start when the main checkout has uncommitted changes. The task goes to the Inbox and tells you to commit or stash them.
- On a conflict it runs `git merge --abort`, so the repository is as it was, and the task goes to the Inbox.
- The worktree and the branch are kept either way, so the task's diffs and any uncommitted work stay readable. Remove them by hand when you are done: `git worktree remove <path>`.

### Agent
A coding CLI Orstra can drive: Claude Code today, Codex next. Configured in Settings (command, model, limits, which of your skills and MCP servers it gets).

### Slot
How many runs can work at the same time on this machine (default 4). Agent and gate runs take a slot; human, switch and action runs don't. When all slots are busy, new runs wait as **queued**.

### Chief of staff
**One ongoing conversation with an agent that sees every task.** It briefs you, answers questions about any task, and acts for you through Orstra: it messages a task's agent, leaves notes, starts, retries or stops tasks, answers decisions, and **watches** tasks to follow up later ("retry HUB-405 when HUB-432 is done").

- It is Claude Code with Orstra's tools **and** its own: Bash, Read, Edit, Write, the web tools, and whatever else Claude Code gives your machine. So it can read a file, change a file and run a command itself. Nothing limits it: no tool list, no path check, no permission question. Its working folders are `~/.orstra` (the database, the workflow files, every task worktree) and the Orstra checkout, and those are where it works, not a fence. It can reach any path you can.
- It opens a file you **attach** to a message the same way, by the path Orstra puts at the end of your message. That folder, `~/.orstra/cos/attachments/`, is inside its workspace.
- **Orstra, not the model, decides what needs your OK** for Orstra's own actions. Actions that need it become a **plan**: a card with Do it / Not now. Messaging agents is allowed by default; starting and retrying tasks asks by default; decisions and stopping always ask.
- **A file or a command of its own has no plan card and no review step.** Work on a task still belongs to the task's agent: only then does the change land on the task's branch and go through the workflow. Ask it for a small fix or a quick look; ask a task for the work.
- Everything it does through Orstra's tools is recorded on the task, marked as done by your chief of staff. Its own files and commands show in the conversation only.

## Screens (one home per concept)

| Screen | Shows | Clicking an item |
|---|---|---|
| **Chief of staff** | The conversation, its plans waiting for your OK, what it is watching, what it may do without asking | Task rows open the task page |
| **Inbox** | Tasks that need you: a decision, a question from an agent, or a stuck task | Opens the task page |
| **Tasks** | All tasks. Board view groups them by their current step (columns = workflow steps); list view groups by status. Filter "Running now" for live work | Opens the task page |
| **Task page** | One task: its steps (with notes), the decision if one is waiting, and the chat with its sessions | — |
| **Workflows** | The workflow editor (canvas or YAML) | Edits a workflow |
| **Settings** | Agents, triggers, repositories, connections, notifications | — |

**Rules for the UI:**
- **One home per object.** Tasks live on the task page, workflows on Workflows, agents and triggers in Settings. Lists only navigate; they never offer a second place to act. The one exception is the chief of staff: you can ask it to act, and it shows every action as a plan or a receipt that links to the task.
- **No list → list links.** From any list you go to the task page and back, never to another list.
- **Talking and notes never mix.** Chat goes to a session; notes go on a step.

## Words we don't use

| Avoid | Say instead | Why |
|---|---|---|
| "Session page" for a task | Task page | A task has many sessions |
| "Steer" | Chat / message | It's just talking to the live session |
| "Job", "pipeline", "execution" | Run / workflow | One word per concept |
| "Board" as a separate place | Tasks (board view) | It's a view of tasks, not its own thing |
| "Attachment" for a file a step makes | Artifact | You add an attachment; a step produces an artifact |
