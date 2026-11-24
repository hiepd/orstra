/**
 * Orstra's own tools for the chief of staff. Read tools always run; action tools run or become a plan
 * the user approves, depending on permissions (see cos.ts). Next to these it has the same built-in tools
 * as a task agent (see COS_BUILTIN_TOOLS).
 * Shared by the daemon (which runs them) and the MCP server (which advertises them to Claude Code).
 */

type Prop = { type: 'string' | 'array'; description: string; enum?: string[]; items?: { type: 'string' } };

export interface CosTool {
  name: string;
  description: string;
  properties: Record<string, Prop>;
  required: string[];
}

const task: Prop = { type: 'string', description: 'The task: its ticket (e.g. HUB-416) or its id (e.g. t-mwstn0x45zr6, or a unique prefix).' };

export const WATCH_UNTIL = ['done', 'needs_you', 'stopped', 'finished'] as const;
export type WatchUntil = (typeof WATCH_UNTIL)[number];

export const COS_TOOLS: CosTool[] = [
  // ---- read ----
  { name: 'list_tasks', description: 'All tasks with their status, current step and attempt. Start here when asked what is going on.', properties: {}, required: [] },
  {
    name: 'get_task',
    description: 'One task in full: description, workflow steps and arrows, every run with its outcome and progress note (did/decided/left/avoid), gate output, what it is waiting for, notes for upcoming steps, and the agent’s latest messages.',
    properties: { task },
    required: ['task'],
  },
  { name: 'get_task_changes', description: 'A task’s worktree: branch, changed files (+/-), commits, and check results.', properties: { task }, required: ['task'] },
  { name: 'get_diff', description: 'The diff of one changed file in a task’s worktree.', properties: { task, path: { type: 'string', description: 'File path inside the worktree, as listed by get_task_changes.' } }, required: ['task', 'path'] },
  { name: 'read_task_file', description: 'Read a text file in a task’s worktree (for example a spec the agent wrote).', properties: { task, path: { type: 'string', description: 'Path relative to the worktree.' } }, required: ['task', 'path'] },
  { name: 'list_workflows', description: 'The workflows tasks can be started with, and their steps.', properties: {}, required: [] },
  { name: 'list_watches', description: 'The follow-ups you are currently watching for.', properties: {}, required: [] },
  {
    name: 'show_tasks',
    description: 'Show tasks to the user as clickable rows with their live status. Use it whenever you mention more than one task, instead of listing them in text.',
    properties: { title: { type: 'string', description: 'A short heading, e.g. "Need you · 3".' }, tasks: { type: 'array', items: { type: 'string' }, description: 'Tickets or ids, in the order to show.' } },
    required: ['title', 'tasks'],
  },
  // ---- act ----
  {
    name: 'message_agent',
    description: 'Send a message into the task’s agent session (the one running or waiting, else the latest). It reads it after its current action; if it was waiting for an answer, it continues. If its run had ended while the task waited on the user, that step takes the task back and any open decision closes.',
    properties: { task, text: { type: 'string', description: 'The message, written as the user would say it.' } },
    required: ['task', 'text'],
  },
  {
    name: 'add_note',
    description: 'Leave a note for a step that has not run yet. Its agent reads it when the step starts. Not for a running agent: use message_agent.',
    properties: { task, step: { type: 'string', description: 'Step id or title.' }, text: { type: 'string', description: 'The note.' } },
    required: ['task', 'step', 'text'],
  },
  {
    name: 'start_task',
    description: 'Start a new task with a workflow.',
    properties: {
      workflow: { type: 'string', description: 'Workflow file name or name, from list_workflows.' },
      title: { type: 'string', description: 'What should be done, in a few words.' },
      description: { type: 'string', description: 'Details the first step’s agent reads. Mention why it was started.' },
      ref: { type: 'string', description: 'Optional ticket id.' },
    },
    required: ['workflow', 'title'],
  },
  {
    name: 'retry_step',
    description: 'Run a step again as a fresh run (default: where the task is now). Use for stuck tasks. The note is read by the new run.',
    properties: { task, step: { type: 'string', description: 'Step id or title (optional).' }, note: { type: 'string', description: 'What to do differently (optional).' } },
    required: ['task'],
  },
  {
    name: 'decide',
    description: 'Answer a task’s waiting decision (a human step) with one of its choices. Always needs the user’s OK.',
    properties: { task, choice: { type: 'string', description: 'One of the choices get_task lists, e.g. approved, changes_requested, rejected.' }, comment: { type: 'string', description: 'Passed to the next step (optional).' } },
    required: ['task', 'choice'],
  },
  { name: 'stop_task', description: 'Stop a task: no more steps run. Always needs the user’s OK.', properties: { task }, required: ['task'] },
  {
    name: 'watch',
    description:
      'Follow up later: you get a message when the task reaches a state, with your instruction, and can act then. done = finished successfully; needs_you = waiting for the user (decision, question, stuck); stopped; finished = done or stopped.',
    properties: { task, until: { type: 'string', enum: [...WATCH_UNTIL], description: 'When to wake you.' }, instruction: { type: 'string', description: 'What to do then, e.g. "Retry HUB-405 Implement with the note: setup is fixed; rebase first."' } },
    required: ['task', 'until', 'instruction'],
  },
  { name: 'unwatch', description: 'Stop a follow-up.', properties: { watch_id: { type: 'string', description: 'From list_watches.' } }, required: ['watch_id'] },
];

export const COS_PROMPT = `You are the user's chief of staff inside Orstra, a local software factory. Coding agents (Claude Code, Codex) run workflows on tasks. A task moves through steps; each agent step runs in its own session in the task's worktree (its own git branch). Gate steps run checks; human steps wait for the user's decision.

What you do: brief the user, answer questions about tasks, suggest what to do next, and act for them: message a task's agent, leave notes for upcoming steps, start, retry or stop tasks, answer decisions, and watch tasks to follow up later.

Next to Orstra's tools you have Claude Code's own tools: Bash, Read, Edit, Write, the web tools, and whatever else this machine gives you. Use them to look at code, to check a fact yourself, or to make a small change. You may have no Glob and no Grep; search with Bash then. You work in 4 kinds of folder: your own (~/.orstra/cos), ~/.orstra (the database, the workflow files, and every task worktree under wt/), the Orstra checkout, and the repository behind each task worktree. A path outside them works too, so give the full path, and stay out of folders the user did not ask about.

Nothing asks you for permission, so you are the only check. Read before you change. Do not delete, push, publish or install anything unless the user asked for it in this conversation. Say what you ran.

Work on a task belongs to its agent. What you do yourself gets no plan card and no review step, and the task's agent never learns about it. So keep your own changes small, and say what you changed. For anything bigger, message the task's agent or start a task. Do not change a task's worktree while its agent runs: you would fight it.

Always read tasks with your tools before answering; never guess.

Some actions need the user's OK. When a tool says it was added to a plan, the user sees a card with "Do it" and "Not now". Propose everything the request needs first, then end your turn with one short sentence. Never say you did something that is still waiting for OK. If they approve, you get a message with the results; then do any follow-up you promised (for example a watch).

When you mention more than one task, call show_tasks so they appear as clickable rows, then write only what matters about them. Refer to a task by its ticket (e.g. HUB-416) or, without one, by its short id.

Write plainly: short sentences, no headings, no tables, no emoji. Lead with what needs the user. When you recommend something, say why in one sentence.

Messages that start with [Orstra] come from the system, not the user: plan results and watches that fired. Act on them, then tell the user briefly what happened.`;

/**
 * The Claude Code flags for the chief of staff's session: Orstra's tools, and no limit on the rest.
 *
 * `bypassPermissions` approves every tool for every path. The session runs with `-p` and the daemon
 * answers no permission request, so a tool that needs one is refused, and only the model learns why.
 * Measured with `--mcp-config` alone: Claude Code refused `mcp__orstra__list_tasks`. So this mode is
 * what makes Orstra's own tools work, not only a convenience.
 *
 * `--strict-mcp-config` keeps the user's own MCP servers out. Orstra's tools then stay in the first tool
 * list instead of behind a search, and the session behaves the same on every machine.
 *
 * No `--tools` flag, so the built-in set is the machine's. Measured on one machine: no Glob and no Grep,
 * with or without `--tools default`. Only a named list (`--tools Bash,Read,…`) creates them, and a named
 * list drops everything it does not name. The prompt tells the model to search with Bash instead.
 *
 * The folders are the session's workspace: a relative path works in them, and Claude Code reads their
 * CLAUDE.md. They are not a fence; every path is open.
 */
export function cosToolArgs(opts: { mcpConfig: string; dirs: string[] }): string[] {
  return [
    '--mcp-config', opts.mcpConfig,
    '--strict-mcp-config',
    '--permission-mode', 'bypassPermissions',
    ...(opts.dirs.length ? ['--add-dir', ...opts.dirs] : []),
    '--append-system-prompt', COS_PROMPT,
  ];
}
