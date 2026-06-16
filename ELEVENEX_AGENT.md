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
- **Sessions** — create, start, **trigger with prompt**, fork, **ask** (read-only hidden fork,
  see below), archive, reset, switch provider, interrupt.
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

## Reading sessions (transcripts)

Wraps the existing export (`GET /sessions/:id/agents/:provider/export` — precision
`full|medium|small`, `includeIds`, `includeChanges`, markdown with `{#id}` per message) but
adds running-awareness, incremental delta, and id-targeted zoom so the agent can inspect long
histories cheaply. This is how the agent "sees what a session has done".

**Tools**

- **`session_status(sessionId)`** — cheap poll, no transcript. Returns execution state
  (`idle | running | requires_action | stale`), provider, branch, turn count, last-activity
  time, aggregate change stats (files, +/−), and whether new items exist since the agent last
  read it. Use this to decide *whether/when* to pull a transcript instead of re-reading one.

- **`read_session(sessionId, { detail, since, ids, includeChanges })`** — the workhorse.
  - `detail`: `low | medium | full` → export precision `small | medium | full`. Default
    `medium`.
  - **Running guard** — if the session is actively running and *not stale*, returns status
    only (`{ running: true, … }`), never a transcript of an in-flight turn. Only
    idle / stopped / stale-running sessions are transcribed; stale-running (the `running`
    flag set but no activity past the threshold — likely a dead process) renders but is
    flagged so the agent knows the capture may be partial.
  - **Incremental by default** — returns only items added since the agent's last read of this
    session. Cursor = last message id, remembered per MCP connection and also returned so
    stateless clients can pass it back. A second call on an unchanged session ⇒ "no new items".
    Pass `since: 'start'` to force a full re-read.
  - **IDs always on** (`{#id}` per message) — cheap, and they power both the cursor and zoom.
  - `ids: string[]` — **zoom**: return just those messages at `full` detail (tool
    input/output + change hunks) instead of the whole full transcript. This is the optimized
    form of "grep the full transcript by id": pull a `low`/`medium` overview first, then zoom
    only the steps that matter.
  - `includeChanges`: default true; per-step file changes (+/−, hunks at `full`).

**Token discipline (the defaults encode this)**
- `medium` + delta + ids-on is the default read.
- poll with `session_status` (tiny) rather than re-reading transcripts.
- zoom by id rather than dumping `full`.
- running sessions never spend tokens on a throwaway transcript.

**Backend work to add (export today is full-only, no guards)**
- export: accept `sinceMessageId` (slice items; render the partial turn as a continuation)
  and an `ids` filter.
- export: consult the agent-runtime execution state (`idle | running | requires_action`) +
  last-activity timestamp to apply the running/stale guard; staleness threshold configurable.
- add a lightweight `session_status` path (state + counts + change summary, no rendering).
- MCP server: per-connection cursor memory keyed by sessionId, with `since: 'start'` reset.

## Asking a session a question (ephemeral read-only fork)

The agent can *interrogate* a session without touching it: "did you handle the timeout case?",
"why approach X?", "what's left to do?". This forks the session into a hidden, read-only
branch that inherits the parent's full conversation + worktree, runs the question, and returns
the final answer. Reuses the existing **plan-chat-fork** machinery (hidden surface + forced
plan mode + write-blocking guard prompt + anchor + reuse-by-id).

**Tool**

- **`ask_session(sessionId, question, { forkId?, provider? })`**
  - Forks the parent at its latest point into a **hidden fork** (new surface `agent_query` —
    not in the normal sidebar; visible only in the elevenex agent UI, grouped under the
    originating session/mission so you can audit what was asked and answered).
  - The fork runs in **plan / read-only mode** (same mechanism plan-chat uses:
    `setPlanMode(true)` ⇒ effective permission mode `plan` ⇒ no writes/edits), and the
    question is wrapped in the write-blocking guard prompt — it answers, it does not
    implement or continue the task.
  - **Returns the final assistant message synchronously** (await `executionState: idle`,
    with timeout). The agent gets just the answer — not a transcript — keeping it cheap.
  - **Follow-ups:** pass `forkId` to continue the same hidden side-conversation instead of
    re-forking, so the agent can interrogate iteratively (reuse-by-id, like plan-chat).
  - Because the fork is a real (hidden) session, `read_session(forkId)` works on it too if
    the agent wants the full reasoning behind an answer.
  - **Parent-must-be-idle guard:** forking a running session captures an in-flight context;
    `ask_session` reuses the running/stale guard and refuses (or waits) if the parent is
    actively running.

**Backend work to add**
- New `surface` value `agent_query` — hidden from the nav tree (like `embedded_plan_chat`),
  listed via an agent-panel query.
- Synchronous ask path: generalize plan-chat-forks to an `agent_query` variant that creates/
  reuses a hidden plan-mode fork, submits the guarded question, **awaits run completion**, and
  returns the final assistant message (today's `submitQuestion` is fire-and-forget; add an
  await-until-idle variant with timeout + cancellation).
- Apply the parent-idle guard before forking.

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
