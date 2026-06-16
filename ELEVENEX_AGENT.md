# Elevenex Agent

A side agent that **operates elevenex for you** from simple prompts — "do JIRA-123", or
"create project X with repos Y and Z". It sets up projects/repos/worktrees/sessions,
triggers the inner coding sessions, drives GitHub, and escalates to you when it needs a
decision. The goal: do almost everything you can do in elevenex, and see almost everything
you can see in elevenex.

## Mental model — a meta-agent

The elevenex agent does **not** write code itself. It *operates elevenex*, which in turn
orchestrates the inner coding agents. Two layers:

- **Outer (this agent)** — decomposes a request into elevenex setup + N inner sessions,
  triggers them with prompts, monitors transcripts, manages git/GitHub, escalates to you.
- **Inner (Claude/Codex/Pi in a session)** — does the actual coding inside a worktree.

"Do JIRA-123" = fetch the ticket → create/find the project → discover & link repos →
create or steal worktrees → spin up sessions → prompt them → watch them → open PRs →
ask you to review.

## Architecture

- **Elevenex MCP server** is the integration surface: it wraps elevenex's existing REST +
  WebSocket API as MCP tools (the chosen "golden path"). One tool surface, many clients.
- **Provider-agnostic agent runtime.** The agent's brain runs over MCP and must be reusable
  across: terminal **Claude Code** (same pattern as the existing TUI Claude UI integration),
  the **Agent SDK**, and **codex**. Mirror the existing `agent-runtime` provider registry —
  the agent logic is provider-neutral; the runtime is pluggable.
- **Elevenex agent panel** (right side of screen) is the primary chat + follow surface. The
  same agent backend powers the in-app panel and any external MCP client.
- **Elicitation channel** — the agent's way to ask the human "approve this / look at this"
  and block until answered, surfaced in the agent panel (MCP elicitation).

## Autonomy modes

Selectable per mission (default = Review destructive):

1. **Full autonomous** — runs end-to-end, including push/PR, stopping only when genuinely
   blocked.
2. **Review destructive** — runs setup and sessions freely, but escalates risky actions:
   stealing others' worktrees, pushing, creating/approving PRs, resets/force ops.
3. **Plan** — lists the ordered actions it intends to take; you accept the plan before it
   executes (builds on the plan UI we prototyped).

## Follow & approve UX (agent panel)

- **Live step tree** in the right-side agent panel: what it's setting up, which sessions it
  spawned, each step's status (`running` / `waiting_approval` / `completed` / `failed`).
  Built on the existing `agent-control` / mission infrastructure.
- **Deep links per step** — click to jump straight to the relevant view (session, PR review,
  change-review diff, worktree sheet). Needs finer-grained deep links than today's
  `/projects/:id` and `/sessions/:id` (e.g. open a session with a specific panel, or a
  specific PR review).
- **Escalations** — at a decision point the step goes `waiting_approval` and a notification
  with an **Open** action points at the exact view; the agent blocks until you respond.

## What the agent can DO  (all backed by existing REST/WS)

- **Projects** — create / archive / list; add & remove repos; discover repos on disk by name.
- **Worktrees** — create / link / **steal** (reads the pool's Available/Yours/Others/Unusable
  categorization to decide and escalate).
- **Sessions** — create, start, **trigger with prompt**, fork, archive, reset, switch
  provider, interrupt.
- **Drive inner sessions** — send follow-up prompts, answer or escalate permission requests,
  inject worktree context, feed diffs back in.
- **Git / GitHub** — status, commit (suggested message), push, get/comment/review PRs, read
  PR checks, feed failing CI back into the session.
- **Actions / productivity** — create & run custom scripts; todos & scratchpad.

## What the agent can SEE

- All projects / repos / sessions / worktrees and their statuses.
- Session transcript, runtime state, snapshot.
- Git change-review diffs, conflicts.
- PR status, checks, conversation.
- Worktree context (AI codebase summary), action output.

## Flagship use cases

- **"Do JIRA-123"** — full ticket → project → repos → worktrees → sessions → PRs → review.
- **"Create project X with repos Y and Z"** — straightforward setup.
- **Status digest** — what's active, what needs review, what's blocked on a permission, what
  has red CI.
- **Multi-repo orchestration** — one ticket across several repos, with ordering (repo A's
  output feeds repo B's prompt).
- **CI babysitter** — watch checks; on failure auto-prompt the session to fix.
- **Review-comment handler** — pull PR review comments and address them in-session.
- **Worktree hygiene** — find & clean stale/merged worktrees.
- **Jira write-back** — move ticket status, comment with the PR link.
- **Recurring jobs** — e.g. "every morning, triage my open PRs."
- **Conflict resolver** — detect conflicts, spawn a session to resolve.

## Gaps to build

- **Jira integration** — no Jira in the backend today. Need a ticket-fetch path (can piggyback
  on the existing `jira-branch` skill / Jira API) plus optional write-back.
- **Notification / elicitation channel** — only toasts + websockets exist today; build the
  agent→human "look at this / approve this" path.
- **Finer deep links** — open a specific panel/PR/diff, not just a page.
- **Mission persistence** — reuse/extend `agent-control` so missions survive reloads and are
  resumable.

## Open questions

- How does the inner session's permission prompts route — always to the outer agent, always to
  the human, or per autonomy mode?
- Where does the agent's own model/runtime config live (per user? per project?).
- Concurrency limits — how many parallel inner sessions before we throttle.
