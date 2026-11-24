# Orstra competitor research (late 2026)

Date of research: 2026-11-24. Method: web search and fetch of vendor docs, changelogs, and news.

> Note: the Orstra row in the matrix describes Orstra before the branch that added Linear and schedule triggers, cost records and budgets, permission questions in the Inbox, draft pull requests, and the Codex runner. Ideas 2, 3, 4 and 7 below are now partly built.

Legend for confidence:

- **[C]** Confirmed. A vendor doc, vendor changelog, or 2 or more news sources state it.
- **[S]** Secondary. Only 1 third-party source states it, or sources disagree.
- **[U]** Not confirmed. I could not find a good source. Treat it as a guess.

Prices change often in this market. Many third-party price pages disagree. Check the vendor page before you use a number.

---

## 1. Summary

1. **The market for local parallel-agent apps consolidated in 2026.** Meta acquired Conductor on 2026-11-04. Conductor Cloud shut down on 2026-11-20, and the Mac app gets updates only until early 2027 [C]. Bloop (Vibe Kanban) shut down on 2026-04-10. Vibe Kanban continues as community open source [C]. Terragon shut down in January 2026 [S]. Stravu stopped Crystal in February 2026 and moved users to Nimbalyst [C]. This leaves fewer maintained, open-source, local tools.
2. **Anthropic now ships most of the "multi-agent shell" in Claude Code itself.** Agent view runs many local background sessions in worktrees and groups them by state [C]. Claude Code Projects is one coordinator conversation that starts parallel cloud threads, keeps project memory, and watches PRs with auto-fix [C]. This is very close to the Orstra "chief of staff". Orstra must win on things Anthropic does not do: local-first, user-defined state machines, hard gates, and many harnesses.
3. **"Software factory as code" is now a named category.** Warp Factories (closed beta, 2026-08-18), SuperPlane 1.0 (Apache 2.0, 2026-10-27), Fabro (DOT graphs with approve gates), OpenAI Symphony (WORKFLOW.md spec, 2026-04-27), Devin dynamic workflows (Python), and GitHub Agentic Workflows (Markdown compiled to Actions) all define agent pipelines as files [C]. Orstra is in this category. It is the only one I found that is local-first with a visual canvas and a human step type.
4. **Verification moved past "tests pass".** Cursor cloud agents attach screenshots and videos to PRs [C]. Linear's agent records screenshots and recordings [C]. Copilot runs code scanning, secret scanning, and a self-review before it opens a PR [C]. Claude Code Review uses many agents plus a verify step that removes false positives [C].
5. **Ticket triggers are table stakes.** Linear launched its own coding agent (2026-06-11) and Loops for automatic dispatch from triage (2026-07-20) [C]. Cursor, Copilot, Codex, Devin, Cyrus, Charlie, Tembo, Emdash, and Conductor all start work from Linear issues [C/S].

---

## 2. Feature matrix

Abbreviations: L = local, C = cloud, H = hybrid. HITL = human in the loop. "PR loop" = the agent reacts to CI failures and review comments on its own PR.

| Product | Deploy | Triggers | Parallel / multi-agent | Review and verify | HITL controls | Cost controls | Price (1 line) | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **Orstra** | L | Manual, chief of staff (Linear planned) | Worktree per task, workflow steps, chief of staff | Gate steps (shell), diff panel | Human step, Inbox, plan cards | Planned | Open source | Active |
| Conductor | L + C (cloud ended) | Manual, from PR / GitHub issue / Linear issue | Many agents, many workspaces | Diff viewer, Checks tab (CI, comments, todos), PR, merge | Manual review | None found | Free; cloud on paid plans | Acquired by Meta, winding down [C] |
| Vibe Kanban | L | Manual, kanban | Workspace per task, 10+ agents | Diff with inline comments to agent, preview browser with devtools | Manual | None found | Free, Apache-2.0 | Company shut; community OSS [C] |
| Claude Squad | L (tmux) | Manual | Worktree per agent | Diff in TUI | Manual, `-y` auto-accept | None | Free, OSS | Active, forks exist [S] |
| Nimbalyst (was Crystal) | L + iOS app | Manual, task board | Worktree per session, Claude + Codex | Per-session diff | Board states, iOS push, answer from phone | None found | Free for individuals | Active [C] |
| Sculptor (Imbue) | L (Docker) | Manual | Container per agent | Pairing Mode (live sync to IDE) | Manual merge | None found | Free [S] | No 2026 release found; Imbue moved to `mngr` [S] |
| Superset | L + remote hosts (cloud beta) | Manual, automations, CLI, SDK, Slack bot | Worktree per task, any CLI agent | Changes pane, "Needs review" group | Triage page | None found | Free; Pro $20/seat/mo [S] | Active [C] |
| Emdash | L or SSH | Linear, Jira, GitHub, GitLab, and more | Worktree per agent, ~20+ agents | Diff, PR, CI checks, merge | Manual | None found | Free, OSS | Active (YC W26) [S] |
| Terragon | C | Manual, GitHub | Container per task | PR | Manual | n/a | Was free beta | Shut down Jan 2026 [S] |
| Cyrus | L (self-host) or C (Team) | Linear assign / mention, GitHub, GitLab, Slack | Worktree per issue, parallel | Progress posted to ticket | Follow-up threads in Linear | BYO key / subscription | Free community; Pro $50/mo [C] | Active [C] |
| Linear agent / Linear Code | C | Delegate issue, Loops from triage | Many issues in parallel | Draft PR, diff in issue, screenshots and recordings | Steer in session, notify on input, merge from Linear | Credits, spend limits, BYOK | Linear AI credits; sandbox per 5 min | Active [C] |
| GitHub Copilot agent / Agent HQ | C (Actions) | Issue assign, `/task`, mobile, VS Code, Linear | Copilot, Claude, Codex from 1 Mission Control | Self-review, code scanning, secret scanning, dependency check | Branch controls, PR review | Premium requests, admin policy | 1 premium request per session (Claude/Codex) | Active [C] |
| OpenAI Codex (app, CLI, cloud) | H | Manual, automations (schedule), GitHub review | Worktrees, `/agents` view, cloud tasks | Code Review inbox, auto reviews, Codex Security | Approval modes | Plan limits | ChatGPT plans (Plus and up) | Active [C] |
| Cursor (cloud agents, Agents Window) | H | Desktop, web, Slack, GitHub, Linear, schedules, webhooks | Agents Window, worktrees, `/best-of-n` | Computer use, screenshots and video on PR, Bugbot | Steer, follow-up | Spend limit, API price per model | Teams $40/user/mo; agents at API price | Active [C] |
| Google Jules | C | Manual, scheduled tasks, suggested tasks, API, CLI | Concurrent tasks (limit by tier) | CI Fixer (beta), Render deploy fix | Plan approval | Task quota by tier | Free tier; Pro ~$19.99/mo [S] | Active; V2 rumored [S] |
| Devin | C (+ Devin Desktop [S]) | Slack, Linear, Jira, API, automations, PagerDuty | Managed child Devins, dynamic workflows (Python) | Devin Review, auto-fix findings, DeepWiki | Approve workflows, playbooks | ACU limit per child session | Subscription + ACU usage [S] | Active [C] |
| Factory (Droids) | H | CLI, IDE, Slack, Linear, CI (`droid exec`) | Missions (multi-agent) [S], custom droids | PR review in GitHub | Spec mode, autonomy levels low/med/high | Rate-limit plans | Pro $20/mo and up [C] | Active [C] |
| OpenHands | H, self-host | GUI, API, Slack, GitHub, GitLab, Bitbucket | Many conversations | Open-source agent, PR | Confirmation mode [U] | Budget and usage controls (enterprise) | Pro $20/mo + LLM at cost [C] | Active [C] |
| Amp | H (orbs, self-hosted orbs) | CLI, web | Subagents, agent-to-agent in orbs | Oracle model for hard reviews | Thread sharing | Per-thread cost to owner | Subscriptions from $20/mo [S] | Active [S] |
| Warp Oz / Factories | C + self-host | Slack, Teams, GitHub, GitLab, ADO, Linear, Jira, webhooks, schedules, MCP | Multi-harness (Claude Code, Codex, Warp Agent), foreman | Verify and review stages, scorers | Plan-review gate | Cost on dashboard; credits | Credits; $10k beta usage | Factories closed beta [C] |
| Charlie / Daemons | C | GitHub, Linear, Slack, Sentry events | Persistent role daemons | PR iteration | Markdown role files | Credits [S] | Trial credits [S] | Active [C] |
| Tembo | C | Slack, Linear, GitHub, Jira, schedules, webhooks | Any agent, parallel | Reviewable output | Ping on output | Credits | Free tier; Pro ~$60/mo [S] | Active [S] |
| SuperPlane | C or self-host | Backlog issues | Model-agnostic pipeline | CI + verify stage + human review | Approvals | BYO keys | Apache-2.0; hosted option | 1.0 on 2026-10-27 [S] |
| Fabro | L (CLI) | Manual CLI | Graph nodes | Gates in graph | `fabro approve` / `reject` | Model routing per node | MIT, OSS | Active [S] |
| OpenAI Symphony | L / self-host (spec) | Issue tracker poll | Workspace per issue | Per WORKFLOW.md | Per WORKFLOW.md | n/a | OSS spec, not maintained as product | Reference only [C] |
| GitHub Agentic Workflows | C (Actions) | Any GitHub event | 1 agent per run | Safe outputs policy | Policy on writes | Actions minutes | OSS, early | Early dev [C] |
| Claude Code (CLI, desktop, web) | H | Manual, scheduled tasks (schedule, API, GitHub), Slack, channels | Subagents, agent teams, agent view, Projects | Code Review (find, verify, rank), `/code-review`, ultrareview, PR auto-fix | Permission modes, auto-mode classifier, Remote Control | Usage limits, spend limit for Code Review, OTel | Pro / Max / Team / Enterprise | Active [C] |

---

## 3. Per-product notes

### 3.1 Conductor (conductor.build)

- **Deploy:** Mac app. Each workspace is a git worktree plus branch. Agents: Claude Code, Codex, Cursor, OpenCode [C]. Source: https://www.conductor.build/llms-full.txt
- **Setup:** Setup scripts run on workspace creation. "Actions" add dev servers and test watchers to a Run button. `CONDUCTOR_PORT` lets many workspaces run local servers at the same time. "Files to copy" handles gitignored files. A `.context` folder holds uncommitted hand-offs [C]. Same source.
- **Review:** Diff viewer. A Checks tab shows git status, CI, deploys, comments, and todos. Create PR, merge, archive [C]. Same source.
- **Start points:** A workspace can start from a branch, a PR, a GitHub issue, or a Linear issue [C]. Same source.
- **Cloud and multiplayer:** Conductor Cloud launched 2026-07-30 (v0.78.0) on Vercel Sandbox, with shared workspace links, live presence, and an API to create workspaces and send prompts [C]. Source: https://www.conductor.build/changelog/0.78.0-introducing-conductor-cloud
- **Stacked PRs:** v0.80.0 (2026-08-10) added GitHub stacks with `gh stack` [C]. Source: https://www.conductor.build/changelog/0.80.0-stacks
- **Status:** Meta acquired Conductor (Melty Inc.) on 2026-11-04. The team joins Meta Superintelligence Labs. Cloud went read-only 2026-11-13 and shut 2026-11-20. Desktop app updates continue only to early 2027 [C]. Sources: https://axios.com/2026/11/04/meta-acquires-ai-coding-startup-conductor , https://theregister.com/ai-and-ml/2026/11/05/meta-brings-conductor-on-board-its-model-train/5307711
- **Price:** Free. Cloud needed a Pro, Teams, or Enterprise plan [C].
- **Standout:** Setup scripts with port allocation. Checks tab that puts CI and PR comments next to the diff.

### 3.2 Vibe Kanban (BloopAI)

- **Deploy:** Local web app. Apache-2.0 [C]. Source: https://github.com/BloopAI/vibe-kanban
- **Features:** Kanban for issues. Each workspace has a branch, a terminal, and a dev server. Diff review with inline comments sent back to the agent. Built-in preview browser with devtools, inspect mode, and device emulation. PR creation with AI description. 10+ agents [C]. Same source.
- **Status:** Bloop shut down on 2026-04-10. Cloud features (shared issues, organisations) were removed 30 days later. The local app stays open source [C/S]. Sources: https://vibekanban.com/blog/shutdown , https://nimbalyst.com/blog/vibe-kanban-after-bloop-whats-next/
- **Reason (reported):** Most users were free users. No business model [S].
- **Standout:** Inline diff comments that go back to the agent as a new prompt. Preview browser inside the app.

### 3.3 Claude Squad (smtg-ai)

- **Deploy:** Go TUI on tmux. Worktree per agent. Works with Claude Code, Codex, Aider, Gemini, OpenCode [S]. Source: https://starlog.is/articles/ai-dev-tools/smtg-ai-claude-squad
- **HITL:** Manual. Experimental `-y` auto-accept [S].
- **Gap:** If you kill a tmux session directly, worktrees and branches stay behind [S].
- **Status:** Active. A fork (Loom) split off at v1.0.17 in April 2026 [S]. Source: https://raw.githubusercontent.com/aidan-bailey/loom/HEAD/README.md
- **Standout:** Very small and simple. Terminal only.

### 3.4 Crystal and Nimbalyst (Stravu)

- **Status:** Crystal v0.3.5 (2026-02-26) is the last release. Stravu points users to Nimbalyst [C]. Source: https://nimbalyst.com/crystal
- **Nimbalyst features:** Session kanban (In Progress, Waiting, Review). One-click worktree per session. Per-session diff. Task board linked to sessions. Desktop notifications and iOS push. iOS app to answer agent questions and review diffs. Claude Code and Codex side by side. Mac, Windows, Linux [C]. Source: https://nimbalyst.com/parallel-claude-code-sessions/
- **Price:** Free for individuals [C]. License not named on the page [U].
- **Standout:** Native iOS app for approvals and diffs.

### 3.5 Sculptor (Imbue)

- **Deploy:** Desktop app. Each agent runs in its own Docker container. Agents never touch the local repo directly [C]. Source: https://docs.imbue.com/features/containers
- **Pairing Mode:** Checks out the agent branch locally, mirrors file changes live, stashes and restores local changes [C]. Source: https://docs.imbue.com/features/pairing-mode
- **Status:** No 2026 Sculptor release found. Imbue launched `mngr` (MIT), a CLI that runs many agents locally, on Modal, or in Docker, with plugins for kanban, cron, and one agent per pytest test [C]. Sources: https://imbue.com/blog/mngr , https://imbue.com/blog/every-mngr-plugin-explained
- **Standout:** Container isolation so agents can run with no permission prompts in a safe box.

### 3.6 Superset (superset.sh)

- **Deploy:** Desktop app (macOS first). Worktree per task. Any terminal agent [C]. Source: https://www.mintlify.com/superset-sh/superset/resources/faq
- **2026 features:** Automations that run an agent in a fresh workspace or continue a session, with retry buttons. CLI and TypeScript SDK (1:1). Slack bot. Remote hosts. "Workspaces" page that groups work by what needs you ("Needs review"). PR view. Session resume [C]. Sources: https://superset.sh/changelog/2026-05-18-teams-slack-sdk-workspaces , https://superset.sh/changelog/2026-08-16-workspaces-triage-editable-markdown , https://superset.sh/changelog/2026-08-09-resume-sessions-pull-requests-cli
- **MCP:** Agents can create and manage workspaces themselves through an MCP server [C].
- **Price:** Free tier, Pro $20/seat/mo [S]. License may be Elastic 2.0 [S].
- **Standout:** Agents can orchestrate other workspaces through MCP. Automations with retry.

### 3.7 Emdash

- **Deploy:** Local desktop app, or SSH to a remote machine. Local SQLite state. ~20+ CLI agents [S]. Source: https://www.ycombinator.com/launches/PRP-emdash-open-source-agentic-development-environment-ade
- **Triggers:** Send issues from Linear, Jira, GitHub, GitLab, Asana, and more to an agent [S].
- **Review:** Diff, PR, CI checks, merge in 1 place [S].
- **Standout:** Widest ticket-tracker list of the local tools.

### 3.8 Terragon

- **Status:** Shut down. The open-source snapshot is dated 2026-01-16 [S]. Source: https://vibed-lab-agents.pages.dev/agent/terragon-labs-terragon-oss
- **What it did:** Cloud containers that ran Claude Code and Codex in parallel and opened PRs [S].

### 3.9 Cyrus (Linear + Claude Code)

- **Deploy:** Self-host (CLI) or cloud (Team plan only) [C]. Source: https://www.atcyrus.com/pricing
- **Triggers:** Assign or mention in Linear. Also GitHub, GitLab, Slack. Harness: Claude Code, Codex, Cursor, Gemini, OpenCode [C]. Source: https://github.com/cyrusagents/cyrus
- **Flow:** Worktree per issue, Claude Code session, activity streamed back to the Linear agent session, follow-up threads [C]. Source: https://linear.app/integrations/cyrus
- **Price:** Community tier free (host it all yourself). Pro $50/mo, self-host [C].
- **Standout:** The closest product to Orstra's planned Linear trigger. It proves that a local runner plus Linear agent sessions works.

### 3.10 Linear agent platform and Linear Code

- **Agent platform:** Third-party agents (Cursor, Copilot, Codex, Devin, Warp, Sentry, Tembo, Cyrus, Charlie) get issues by delegation and post into agent sessions [C]. Source: https://linear.app/integrations/agents
- **Linear Code (first-party):** Launched 2026-06-11. Runs Claude Code or Codex in a cloud sandbox. Makes a draft PR and puts the diff on the issue [C]. Source: https://linear.app/changelog/2026-06-11-coding-sessions
- **Environment:** Per-repo environment with runtimes, env vars, a prepare script, files, guidance, and sandbox size. The agent can run the app and use browser automation for screenshots or recordings [C]. Source: https://linear.app/docs/linear-cloud-coding-agent
- **Triggers:** Delegate an issue. Loops (2026-07-20) start the agent when Triage Intelligence labels an issue as a bug [C]. Same source and https://linear.app/agents
- **HITL:** Steer in the session. Notify when input is needed. Ask the agent to fix review comments, rebase, or fix lint [C].
- **Cost:** AI credits or BYOK. Sandbox time billed in 5-minute steps. Spend limits under "Usage & limits" [C].
- **Standout:** Triage-to-PR with no human start. Verification artifacts on the issue.

### 3.11 GitHub Copilot coding agent and Agent HQ

- **Mission Control:** 1 place to assign, steer, and track agent tasks on web, VS Code, mobile, and CLI [C]. Source: https://github.blog/changelog/2025-10-28-a-mission-control-to-assign-steer-and-track-copilot-coding-agent-tasks/
- **Third-party agents:** Claude and Codex in public preview on Agent HQ since 2026-02-04 for Pro+ and Enterprise. Each session uses 1 premium request [C]. Source: https://github.blog/news-insights/product-news/pick-your-agent-use-claude-and-codex-on-agent-hq/
- **Verify:** The agent runs Copilot code review on its own change before it opens the PR. It runs code scanning, secret scanning, and dependency checks [C]. Sources: https://github.blog/ai-and-ml/github-copilot/whats-new-with-github-copilot-coding-agent/ , https://github.blog/changelog/2025-10-28-copilot-coding-agent-now-automatically-validates-code-security-and-quality/
- **Custom agents:** Files under `.github/agents/`, shared across an org [C].
- **Agentic Workflows (gh-aw):** Markdown files compiled into Actions YAML. The agent has no write access. "Safe outputs" apply its requested writes after a policy check [C]. Source: https://github.github.com/gh-aw/reference/safe-outputs/
- **Standout:** Self-review plus security scans before a human sees the PR. Safe-outputs pattern.

### 3.12 OpenAI Codex (app, CLI, cloud)

- **Codex app:** macOS (Feb 2026) and Windows (2026-03-04). Many agent threads per project. Built-in worktrees. Automations on a schedule in background worktrees. Shared skills [C]. Sources: https://openai.com/index/introducing-the-codex-app/ , https://developers.openai.com/codex/app/features
- **DevDay 2026-09-29:** Persistent cloud environments across desktop, web, and mobile. CLI refresh with voice, `/agents` view for parallel work, session resume, worktrees. Code Review inbox and automatic reviews. Codex Security Cloud scans repos [C]. Source: https://techcrunch.com/2026/09/29/openai-gives-codex-reusable-cloud-environments-that-work-across-devices/
- **Symphony:** Open-source spec (2026-04-27). An issue tracker becomes the control plane. A `WORKFLOW.md` per repo holds YAML front matter (tracker, agent command, workspace, hooks) and a prompt body. Restart recovery uses the tracker and filesystem, with no database. OpenAI does not plan to maintain it as a product [C]. Sources: https://openai.com/index/open-source-codex-orchestration-symphony , https://betterstack.com/community/guides/ai/openai-symphony/
- **Price:** ChatGPT plans. Cloud from Plus [S].
- **Standout:** Symphony is a public spec for the same idea as Orstra. Orstra could read or export `WORKFLOW.md`.

### 3.13 Cursor (cloud agents, Agents Window, Bugbot)

- **Cloud agents:** Formerly background agents. Start from the desktop app, cursor.com/agents, or `@Cursor` in Slack, GitHub, or Linear [C]. Source: https://cursor.com/docs/cloud-agent.md
- **Automations:** Agents run on schedules or on events from GitHub, Slack, Linear, and webhooks. Self-hosted worker pools [C]. Source: https://cursor.com/cloud
- **Computer use and artifacts (2026-02-24):** Each agent runs in its own VM. It attaches screenshots, videos, and log references to the PR [C]. Source: https://cursor.com/changelog/02-24-26
- **Cursor 3 (2026-04-02):** Agents Window runs many agents across local, worktrees, cloud, and SSH. `/best-of-n` runs 1 task on many models [C]. Source: https://cursor.com/changelog/3-0
- **Cost:** Cloud agents bill at API price for the model. Cursor asks for a spend limit on first use [C]. Source: https://cursor.com/docs/account/pricing.md
- **Bugbot:** AI PR review. Moved to usage billing in May 2026 [S]. Source: https://cursor.com/ja/blog/may-2026-bugbot-changes
- **Standout:** Video proof on the PR. Best-of-N.

### 3.14 Google Jules

- **Deploy:** Cloud VM. Web, CLI (Jules Tools), and API (v1alpha [S]) [C]. Source: https://blog.google/technology/google-labs/jules-tools-jules-api/
- **Proactive:** Scheduled Tasks (everyone). Suggested Tasks scan the repo, starting with `#todo` comments (Pro and Ultra, experimental). Render integration: on a failed deploy, Jules reads logs and opens a fix PR [C]. Source: https://blog.google/technology/developers/jules-proactive-updates/
- **CI Fixer (beta, Jan 2026):** Tries to fix failed CI on its own PRs [S]. Source: https://tessl.io/blog/google-wants-to-make-jules-a-more-proactive-coding-colleague/
- **Price:** Free tier with a daily task quota. Pro ~$19.99/mo [S].
- **Status:** "Jules V2" is reported but not confirmed [U].
- **Standout:** Suggested tasks (the agent finds work).

### 3.15 Devin (Cognition)

- **Managed Devins (2026-03-19):** A parent session splits work into child Devins, each in its own VM. The parent can set prompts, playbooks, tags, and ACU limits per child, send follow-ups, track ACU use, and stop children [C]. Source: https://cognition.ai/blog/devin-can-now-manage-devins
- **Dynamic workflows:** Devin writes a deterministic Python script with `agent()`, `pipeline()`, `parallel()`. Each `agent()` takes a JSON Schema and returns a typed dict. Resume replays finished agents by a hash of prompt, schema, and settings. A proven workflow saves to the repo as a skill (`workflow.py` + `SKILL.md`). Optional approval before each run [C]. Source: https://docs.devin.ai/work-with-devin/dynamic-workflows.md
- **2026 release notes:** One-time and recurring automation schedules. PagerDuty triggers (Devin as on-call). "Automatically fix Devin Review findings" setting. MCP tools run on Devin servers [S]. Source: https://docs.devin.ai/release-notes/2026
- **Price:** Subscription with ACU capacity, then pay as you go. Figures differ by source [S]. Source: https://www.usecarly.com/blog/devin-pricing
- **Standout:** Per-child budget caps. Typed outputs with replay.

### 3.16 Factory (Droids)

- **Deploy:** CLI, IDE, desktop, SDK. `droid exec` is a headless mode for CI and cron. Default is read-only. `--auto low|medium|high` sets autonomy [C]. Source: https://docs.factory.ai/cli/droid-exec/overview
- **Spec mode:** Read-only plan first. After approval, the droid implements. A separate model can do the plan (`--spec-model`) [C]. Source: https://docs.factory.ai/autonomy-and-safety/specification-mode.md
- **Missions:** Split large work into milestones across many agents [S]. Source: https://sacra.com/research/factory
- **Price:** Pro $20/mo and higher tiers [C]. Source: https://www.factory.ai/pricing
- **Standout:** Named autonomy levels. Separate model for the plan.

### 3.17 OpenHands (All Hands AI)

- **Deploy:** Open-source agent. OpenHands Cloud (SaaS) or self-host [C]. Source: https://openhands.dev/pricing
- **Access:** GUI, API, Slack, GitHub, GitLab, Bitbucket [C]. Source: https://openhands.dev/blog/all-new-openhands-cloud-more-model-choice-lower-prices-slicker-design
- **Controls:** Enterprise page lists SSO, RBAC, audit logs, budgets and usage controls, MCP, secrets [C].
- **Price:** Pro $20/mo for cloud runtime. LLM at cost, or BYO key [C]. Source: https://docs.all-hands.dev/openhands/usage/cloud/pro-subscription
- **Claim to check:** A self-hosted "control center" that also runs Claude Code, Codex, and Gemini [U].
- **Standout:** Fully open source agent plus budgets.

### 3.18 Amp (Sourcegraph / Amp Inc.)

- **Deploy:** CLI and web. Cloud "orbs". Self-hosted orbs announced 2026-10-22 [S]. Source: https://baeseokjae.github.io/posts/amp-code-review-2026/
- **Multi-agent:** Subagents. Agent-to-agent: an agent can start a thread in an orb or on another machine and wait for its result [C]. Source: https://ampcode.com/docs/orbs/agent-to-agent
- **Handoff:** Replaces compaction. Starts a new thread with selected context and a clear goal. The user reviews what passes over [C]. Source: https://tessl.io/blog/amp-retires-compaction-for-a-cleaner-handoff-in-the-coding-agent-context-race
- **Oracle:** A second reasoning model for hard problems [C].
- **Price:** Subscriptions (from $20/mo) [S]. Source: https://ampcode.com/news/subscriptions
- **Standout:** Handoff with user review. This is close to Orstra progress entries.

### 3.19 Warp (Oz and Warp Factories)

- **Oz (2026-02-10):** Cloud platform to run and orchestrate coding agents. Multi-harness since May 2026 (Claude Code, Codex, Warp Agent). Self-host execution while Oz does orchestration. Credits for inference and compute [C]. Sources: https://www.warp.dev/newsroom/2026/2/10/warp-launches-oz-the-orchestration-platform-for-cloud-coding-agents , https://warp.dev/blog/multi-harness-cloud-agent-orchestration
- **Warp Factories (closed beta 2026-08-18):** Definition files (repos, workers, automations, runners, skills, MCP servers) live in a repo and change through PR review. A "Blueprint" defines stages (triage, plan, implement, review; diagram also shows spec, verify, ship, monitor) and where a person must decide. A "foreman" follows transitions and can send work back. Plan-review gate. Triggers: Slack, Teams, GitHub, GitLab, Azure DevOps, Linear, Jira, webhooks, schedules. A Factory MCP lets a local agent hand work to the factory. Dashboard shows cost. Workflow policy does not grant merge access [C]. Sources: https://docs.warp.dev/factories.md , https://techcrunch.com/2026/08/18/warps-new-system-is-an-out-of-the-box-software-factory-for-ai-development/
- **Claim:** Warp automates ~30% of its own tasks with factories (vendor claim) [S].
- **Standout:** The nearest commercial match to Orstra. Cloud first, enterprise focus.

### 3.20 Charlie Labs (Charlie and Daemons)

- **Charlie:** Cloud agent. Takes Linear issues, opens and iterates on GitHub PRs, talks in Slack. Event runtime on GitHub, Linear, Slack, Sentry [C]. Source: https://linear.app/integrations/charlie
- **Daemons (2026-06-17):** Persistent role-scoped agents. Each role is a Markdown file (trigger, cadence, what it does), for example a docs-drift maintainer. Runs are bounded activations, not a forever process [C]. Sources: https://charlielabs.ai/blog/introducing-daemons/ , https://charlielabs.ai/blog/daemons-persistent-roles-bounded-runs/
- **Standout:** "Watcher" roles that keep PRs, issues, CI, and docs healthy after the coding agent finishes.

### 3.21 Tembo

- **Deploy:** Cloud sandbox. Agent-agnostic (Claude Code, Cursor, Codex, Amp, OpenCode) [S]. Source: https://rywalker.com/research/tembo
- **Triggers:** Slack, Linear, GitHub, Jira, schedules, webhooks. Public API, automations, multi-agent [C]. Source: https://www.tembo.io/changelog/automations-multi-agent-sandbox-and-public-api
- **Price:** Free 10 credits/week; Pro ~$60/mo [S].
- **Standout:** Orchestration layer that sits above any agent.

### 3.22 Open-source "software factory" projects

- **SuperPlane 1.0** (Apache-2.0, 2026-10-27 [S]): Ticket to verified, review-ready PR. Model-agnostic. Self-host or hosted. Ambiguous work stays with people [C]. Source: https://sdtimes.com/agentic-development/superplane-1-0-an-open-source-software-factory/
- **Fabro** (MIT): Each workflow is a Graphviz DOT graph. Node shape sets the handler type. Approve gate with "[A] Approve" and "[R] Revise" edges. A CSS-like `model_stylesheet` routes nodes to models. CLI `fabro approve <run-id>` [S]. Source: https://research.tedneward.com/languages/fabro.html
- **disler/super-simple-software-factory:** Python owns the graph. Agents are bounded nodes. YAML config [S]. Source: https://github.com/disler/super-simple-software-factory

### 3.23 Kiro (AWS)

- Spec-driven IDE: `requirements.md`, `design.md`, `tasks.md` before code. Agent hooks in `.kiro/hooks/` start background agent tasks on file save, create, delete, or manual trigger. Steering files for team rules [C]. Sources: https://kiro.dev/about/ , https://aws.amazon.com/jp/blogs/news/automate-your-development-workflow-with-agent-hooks
- A background autonomous agent that opens PRs is reported [S].

### 3.24 Claude Code (Anthropic)

- **Subagents and agent teams:** Subagents report back to the parent. Agent teams are separate Claude Code instances that talk peer to peer (experimental) [C]. Source: https://code.claude.com/docs/en/agent-teams.md
- **Hooks:** Lifecycle hooks in the CLI and SDK [C]. Source: https://code.claude.com/docs/en/hooks.md
- **Agent view (`claude agents`):** Local background sessions grouped as Needs input, Working, Ready for review, Completed. Linked PR status. Each session moves to its own worktree under `.claude/worktrees/`. It commits and pushes but never pushes to main, force-pushes, or merges. Notifications on input, finish, or failure. `claude agents --json` for scripts. Research preview [C]. Source: https://code.claude.com/docs/en/agent-view.md
- **Projects:** 1 ongoing conversation. Claude starts a thread (usually a cloud session) per task. Overview pane: Ready for review, Waiting on you, Landing. Project memory (`MEMORY.md`) that every thread reads. Threads watch their PR with auto-fix (fix CI, answer review comments). A thread can run on your own computer through Remote Control. Threads stopped by a usage limit continue when the limit resets. Public beta on Pro, Max, Ultra [C]. Source: https://code.claude.com/docs/en/claude-projects.md
- **Scheduled tasks (formerly routines):** Prompt + repos + connectors. Triggers: schedule, API (`/fire` endpoint), GitHub events (with filters on branch, labels). Run on Anthropic cloud or a self-hosted environment. Push to `claude/` branches. Count against plan usage. Hourly caps on events [C]. Source: https://code.claude.com/docs/en/routines
- **Channels:** An MCP server pushes events (Telegram, Discord, iMessage, webhooks) into a running local session. Channels can relay permission prompts so you approve from your phone. Research preview [C]. Source: https://code.claude.com/docs/en/channels.md
- **Permission modes:** `default`, `acceptEdits`, `plan`, `auto`, `dontAsk`, `bypassPermissions`. Auto mode uses a classifier model. It blocks force push, `git reset --hard`, prod deploys, merge of unapproved PRs, `curl | bash`, and more. 3 blocks in a row or 20 total pause auto mode. Headless `-p` supports `--permission-mode auto` and `--permission-prompt-tool` [C]. Source: https://code.claude.com/docs/en/permission-modes.md
- **Code Review:** Several agents find issues in parallel. A verify step removes false positives. Findings are ranked by severity and posted inline with a check run. Levels Quick, Standard, Deep. `REVIEW.md` customizes it. Monthly spend limit. Team and Enterprise [C]. Source: https://code.claude.com/docs/en/code-review.md
- **GitHub Actions:** `anthropics/claude-code-action` runs Claude Code in your own CI [C]. Source: https://code.claude.com/docs/en/github-actions.md
- **Standout:** Anthropic now covers local multi-session, cloud coordination, schedules, and review. Orstra must build on these, not copy them.

---

## 4. What Orstra lacks (gap list)

Each gap names the products that have it.

| Gap | Who has it |
| --- | --- |
| PR feedback loop (agent reacts to CI failures and review comments) | Claude Code Projects auto-fix, Jules CI Fixer, Devin Review auto-fix, Linear Code, Copilot |
| Ticket triggers and two-way ticket updates | Linear Code, Cyrus, Cursor, Copilot, Devin, Charlie, Tembo, Emdash, Warp, Symphony |
| Schedule, webhook, and GitHub-event triggers | Claude scheduled tasks, Codex automations, Cursor automations, Jules, Devin, Superset, Tembo, Warp |
| Visual proof (screenshots, video, preview browser) | Cursor, Linear Code, Vibe Kanban, Jules + Render |
| Built-in AI review step with false-positive filter | Claude Code Review, Copilot self-review, Bugbot, Devin Review, Factory |
| Budgets per task or per child agent | Devin (ACU per child), Linear (spend limits), Cursor (spend limit), Claude Code Review (monthly limit) |
| Remote approvals and push notices | Nimbalyst iOS, Claude Remote Control and channels, Copilot mobile, Codex mobile |
| Workflow files in the repo, reviewed by PR | Warp Factories, Symphony `WORKFLOW.md`, gh-aw, Charlie `DAEMON.md`, Devin `workflow.py` skill |
| Typed step outputs and replay on resume | Devin dynamic workflows |
| Best-of-N and fan-out steps | Cursor `/best-of-n`, Devin `parallel()`, mngr per-test agents |
| Per-step model or harness choice | Fabro `model_stylesheet`, Warp per-worker harness, Factory `--spec-model` |
| Shared memory across tasks | Claude Code Projects memory, Devin knowledge, Kiro steering |
| Container isolation option | Sculptor, mngr (Docker, Modal), cloud products |
| Stacked PRs and merge-queue status | Conductor stacks, Claude Projects "Landing" |

---

## 5. Ranked feature ideas for Orstra

Size: S = days, M = 1 to 3 weeks, L = more than 3 weeks. Sizes are rough guesses [U].

### 1. PR and CI feedback loop step (size M)

- **What:** After `git.merge` or a draft PR action, a "watch" step polls CI and PR review comments. On a failure or a new comment, it routes back to an agent step with the log or comment as input. A loop cap applies. Unmatched results go to the Inbox.
- **Proof of demand:** Claude Code Projects auto-fix, Jules CI Fixer, Devin "auto-fix Devin Review findings", Linear Code (fix review comments, rebase, lint), Copilot.
- **Fit:** Orstra already has gates, switches, loop caps, and an Inbox. This is a new action type plus a poller in the daemon. The chief of staff already "watches tasks".

### 2. Linear trigger with two-way sync (size M, already planned)

- **What:** A Linear issue (assign, label, or status) starts a workflow. Progress entries post to the Linear agent session. Human steps can appear as Linear questions. Draft PR links attach to the issue.
- **Proof:** Linear Code and Loops, Cyrus, Cursor, Copilot, Devin, Charlie, Tembo, Emdash, Conductor, Symphony.
- **Fit:** Cyrus proves a local runner can serve Linear agent sessions through a webhook relay. The Did / Decided / Left / Avoid entries map well to Linear agent activity.

### 3. Permission requests in the Inbox plus a safe auto policy (size M, partly planned)

- **What:** Run Claude Code with `--permission-mode auto` or `--permission-prompt-tool` that sends each blocked action to the Inbox as an approve/deny card. Let a workflow set the mode per step (for example `plan` for a plan step, `auto` for implement).
- **Proof:** Claude Code auto mode and channels permission relay, Remote Control, Nimbalyst, Factory autonomy levels, gh-aw safe outputs.
- **Fit:** The recent commit "Drop the limits: bypassPermissions" removes all checks. A local daemon on the user's own machine has more to lose than a cloud sandbox. This gives safety without prompt fatigue.

### 4. Cost and usage budgets per task and per step (size S to M, planned)

- **What:** Record tokens and cost per step from Claude Code output. Let a workflow set `max_cost` or `max_turns` per step and per task. At the cap, stop and send the task to the Inbox. Optional: resume a task when a plan usage limit resets.
- **Proof:** Devin ACU limits per child, Linear spend limits, Cursor spend limit, Claude Code Review monthly limit, Claude Projects "continue when usage limits reset", Warp cost dashboard.
- **Fit:** Loops with caps are already in the model. A budget is one more cap. Users on Max plans care about limits more than dollars, so show both.

### 5. Verify step with visual proof (size M to L)

- **What:** A gate type that starts the app (from a run script with a free port), runs Playwright or a browser agent, and saves screenshots or a short video. The task page and the PR body show them.
- **Proof:** Cursor computer use with video on PRs, Linear Code screenshots and recordings, Vibe Kanban preview browser, Jules + Render.
- **Fit:** Local runs have the user's real dev setup, which cloud tools must rebuild. The artifact panel fits the task page.

### 6. Built-in AI review step (size M)

- **What:** A reusable workflow node: N reviewer agents read the diff in parallel, a verify agent removes false positives, and the result ranks findings by severity. Findings above a threshold loop back to the implement step. Reads `REVIEW.md`.
- **Proof:** Claude Code Review (find, verify, rank), Copilot self-review before PR, Cursor Bugbot, Devin Review, Factory PR review.
- **Fit:** It is a template of existing step types (agent, switch, loop). It runs on the user's subscription with no extra service.

### 7. Schedule, webhook, and GitHub-event triggers (size S to M)

- **What:** Cron triggers ("nightly dependency check"), a local webhook endpoint, and GitHub event triggers (PR opened, label added) that start a workflow.
- **Proof:** Claude Code scheduled tasks (schedule, API, GitHub), Codex automations, Cursor automations, Jules scheduled tasks, Devin automations and PagerDuty, Superset automations, Tembo, Warp.
- **Fit:** The daemon already runs all the time. Triggers are a thin layer over "create task with workflow X".

### 8. Workflows as code in the repo, plus a template gallery (size S to M)

- **What:** Load workflows from `.orstra/workflows/*.yaml` in the repo, so changes go through PR review. Keep the canvas as an editor for those files. Ship starter templates: plan, approve, implement, review, PR; bug triage; dependency update. Optional import of Symphony `WORKFLOW.md`.
- **Proof:** Warp Factories definition files, Symphony `WORKFLOW.md`, gh-aw Markdown workflows, Charlie `DAEMON.md`, Devin `workflow.py` saved as a skill, Fabro `.fabro` files.
- **Fit:** Orstra already uses YAML. Repo files make workflows shareable, which helps open-source growth.

### 9. Typed step outputs with JSON Schema (size M)

- **What:** An agent step can declare an output schema. Claude Code returns structured output that matches it. Switch steps branch on fields (for example `risk: high`). On resume, finished steps replay their stored output.
- **Proof:** Devin dynamic workflows (`agent()` with JSON Schema, replay by hash), Claude Agent SDK structured outputs.
- **Fit:** Progress entries are already structured. Typed outputs make switches reliable instead of text matches.

### 10. Fan-out and best-of-N steps (size M to L)

- **What:** A "parallel" step that runs N agents on the same goal (different models or prompts) and picks one by gate result or a judge agent. A "map" step runs 1 agent per item (per failed test, per package).
- **Proof:** Cursor `/best-of-n`, Devin `parallel()` and "batch 3 agents, pick best", Imbue mngr one agent per pytest test.
- **Fit:** Worktrees per run already exist. A local machine limits concurrency, so add a max-parallel setting.

### 11. Per-step harness and model routing (size S to M)

- **What:** Each agent step names a harness (Claude Code, Codex) and a model. Defaults per workflow. Example: a cheap model for triage, a strong model for implement, a different vendor for review.
- **Proof:** Fabro `model_stylesheet`, Warp per-worker harness and multi-harness Oz, Factory `--spec-model`, Linear model choice, Conductor and Superset multi-agent.
- **Fit:** Codex CLI support is next on the roadmap. Design the step schema for many harnesses now.

### 12. Push notices and remote approvals (size S)

- **What:** Send Inbox items to a phone or chat (ntfy, Slack, Telegram, or a Claude Code channel). Allow approve/deny from the notice for human steps and permission cards.
- **Proof:** Nimbalyst iOS push, Claude Remote Control and channels, Copilot mobile, Codex on mobile, agent view notifications.
- **Fit:** A local daemon with a web UI is useless when the user is away. A notice channel is small work and removes the main pain.

### 13. Shared project memory across tasks (size S to M)

- **What:** A memory file per repo (pitfalls, decisions) that the chief of staff and agents append to after review. Every new step session reads it. The "Avoid" entries in progress are a natural source.
- **Proof:** Claude Code Projects memory (`MEMORY.md`), Devin knowledge and playbooks, Kiro steering files, Amp handoff.
- **Fit:** Each step is a fresh session, so lessons are lost unless Orstra keeps them.

### 14. Workspace setup and run scripts with port allocation (size S to M, if not already present)

- **What:** Per-repo setup script on worktree creation, files to copy (for example `.env`), and run commands with a unique port per task.
- **Proof:** Conductor setup scripts and `CONDUCTOR_PORT`, Superset setup/teardown/run config, Vibe Kanban dev server per workspace, Linear Code prepare script.
- **Fit:** Gates and the verify step (idea 5) need a working app in each worktree. [U] I did not check if Orstra already has this.

### 15. Optional container sandbox per task (size L)

- **What:** Run the agent and gates inside a Docker container that mounts only the worktree. Use it for `bypassPermissions` or auto-merge workflows.
- **Proof:** Sculptor containers, Imbue mngr (Docker, Modal), all cloud products (VM per task).
- **Fit:** It keeps the local promise but limits damage. It is large work, so put it after the permission policy (idea 3).

Other ideas with less proof: stacked PR support (Conductor), "suggested tasks" where the chief of staff proposes work from TODOs and errors (Jules), and a metrics view of success rate and cost per workflow (Warp Factories dashboard).

---

## 6. Things I could not confirm

- Amp prices and free tier (sources disagree).
- Devin, Factory, Tembo, and Jules exact prices (third-party pages disagree).
- Jules V2 launch.
- Sculptor 2026 status (no release found).
- OpenHands "control center" that runs Claude Code and Codex.
- Kiro background agent that opens PRs.
- Superset license (Elastic 2.0 or other) and the scope of its cloud beta.
- Emdash canonical repository and license.
- SuperPlane 1.0 release date (1 source).
- Some search results named model versions (for example "GPT-6 Sol" in Linear docs). I report them as the source stated and did not check them.
