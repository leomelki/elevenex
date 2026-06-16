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

## How elevenex works (primer the agent must know)

This section is surfaced to the agent (MCP server instructions / system prompt) so it
understands the domain *before* acting and doesn't have to reverse-engineer it.

**The object model, top to bottom:**

- **Project** — the top-level container for a piece of work. Groups one or more repos plus
  its sessions, todos, scratchpad, settings. A ticket/task usually maps to one project.
- **Repo** — a git repository linked into a project by its path on disk. A project can hold
  several repos (a ticket that spans services/packages).
- **Worktree** — a physical git worktree: a checkout of a repo at some branch in its own
  directory, so many branches can be worked on at once without clashing. Sessions run *inside*
  a worktree.
- **Workspace** — the link record that binds a repo's worktree into a project and tracks its
  branch, dirty state, and pending stash. (Worktree = the checkout on disk; workspace = "this
  project is using that checkout".)
- **Worktree pool** — the set of reusable worktrees for a repo, each assessed as **Available**
  (free to use), **Yours** (already linked to this project), **Others** (in use by another
  project — "stealing" it needs care/approval), or **Unusable** (missing/locked/error). Prefer
  Available/Yours; only take Others with escalation.
- **Session** — an agent conversation bound to a repo + worktree + branch, running one
  **provider** (`claude` / `codex` / `pi`). Key fields the agent reasons about:
  - **execution state** — `idle | running | requires_action` (plus `stale`): whether the inner
    agent is mid-turn, waiting on a permission, or done. Read/ask only when not actively running.
  - **surface** — `session` (visible in the sidebar) vs hidden (`embedded_plan_chat`,
    `agent_query`). The agent's read-only question forks are hidden.
  - **fork** — a session can be branched; a hidden read-only plan-mode fork is how the agent
    *asks a session a question* without disturbing it (see `ask_session`).
  - **plan mode** — a permission mode that blocks all writes/edits (read-only).
- **Worktree context** — an AI-generated codebase summary that can be injected into a session
  so the inner agent starts oriented instead of exploring from scratch.

**Relationships:** `Project → Repos → Worktrees/Workspaces → Sessions`. Triggering a session
with a prompt runs the inner coding agent inside that worktree on that branch.

**Where to send the human:** deep links — `/projects/:id`, `/sessions/:id` today (finer links
to a specific panel/PR/diff are planned). Use these in notifications and mission steps.

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

### Design principle — only wrap what the CLI can't do

The MCP server covers **elevenex-specific state and orchestration** (projects, repos,
worktree pool, sessions, transcripts, the agent panel). It does **not** re-wrap things the
agent's own runtime already does well from a shell — or things another MCP server already
provides:

- **Git** (`status`, stage/unstage, `commit`, `push`, log, diff) → the agent runs `git`
  directly. Commit-message generation is just the agent (or a one-off subagent) writing a
  message — no dedicated tool needed.
- **GitHub** (PRs, reviews, comments, checks, branch context) → the agent runs `gh` directly.
- **Jira** (fetch ticket, transition status, comment) → the agent uses the **Jira MCP**
  directly; elevenex does not proxy it.

The MCP tools' job is to tell the agent *where* (worktree path, branch, session) and to expose
state that has no CLI (transcripts, pool assessment, the panel/elicitation channel).

## Current context (what the user is looking at)

The agent panel always feeds the agent the **currently-open element** as ambient context, so the
user can say "what did *this* session do?", "fix *this*", or "open another session *here*"
without naming IDs:

- Always the current **`projectId`** (the open project).
- If a session is open, also the **`sessionId`** plus its resolved **project / repo / worktree /
  branch / provider**.
- Refreshed as the user navigates; the agent treats it as the **default scope/target** unless
  the user names something else, and resolves "this"/"here"/"the current one" against it.

For external MCP clients with no elevenex UI, this context may be absent — the agent then asks
or uses `find_sessions` / `project_overview` to locate the target.

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

## What the agent can DO  (capability inventory — see *Tool surface* for how it's packaged)

- **Projects** — create / archive / list; add & remove repos; discover repos on disk by name.
- **Worktrees** — create / link / **steal** (reads the pool's Available/Yours/Others/Unusable
  categorization to decide and escalate).
- **Sessions** — create, start, **trigger with prompt**, fork, **ask** (read-only hidden fork,
  see below), archive, reset, switch provider, interrupt.
- **Drive inner sessions** — send follow-up prompts, answer or escalate permission requests,
  inject worktree context, feed diffs back in.
- **Git / GitHub** — via `git`/`gh` CLI directly in the worktree, not MCP tools (see design
  principle). The agent commits, pushes, opens/reviews PRs, reads checks, and feeds failing
  CI back into the session itself.
- **Actions / productivity** — create & run custom scripts; todos & scratchpad.

## What the agent can SEE

- All projects / repos / sessions / worktrees and their statuses.
- Session transcript, runtime state, snapshot.
- Git change-review diffs, conflicts.
- PR status, checks, conversation.
- Worktree context (AI codebase summary), action output.

## Tool surface — composable primitives

**The agent stays responsible for everything it does.** Tools are **granular primitives, not
bundled workflows.** No macro tool sets up a whole task behind one call — that would hide
decisions the agent is accountable for, box it in on precise requests ("just relink *this*
worktree to *that* branch"), and make **Plan mode opaque** (the approved plan must *be* the
ordered list of concrete actions, not a single black box). The agent composes the primitives
itself, deciding — and being accountable — at each step.

We still optimize hard, but optimization here means making each primitive **fast and
low-context**, never taking a decision away from the agent.

**"Optimized" without abstracting away control**
- **Return ready-to-use results.** Every tool returns the ids/handles it touched, a `deepLink`,
  and a short *next-step* hint — fewer re-fetches, no URL building.
- **Idempotent / find-or-create** by natural identity (project name, repo path, repo+branch) —
  so a *re-run or resumed* mission doesn't duplicate, without bundling steps together.
- **Event-driven over polling** — wake on change instead of status loops.
- **Aggregate *reads* for orientation** — observation only; takes no decisions.
- **Structured errors** with a remediation hint ("branch exists → reuse or rename").

**Setup primitives** (the agent runs the sequence explicitly)
- `find_or_create_project`, `add_repo` / `remove_repo`
- `assess_worktree_pool(repoId, …)` — the Available/Yours/Others/Unusable view (scoped/capped)
- `create_worktree` (async job; the agent may await), `link_worktree`, `steal_worktree`
- `create_session({ repo, worktree, branch, provider?, name? })` — the agent picks the worktree
  first (from the pool assessment) and passes it in; worktree choice is *its* decision, not
  hidden inside session creation
- `set_provider` / `set_model` / `set_permission_mode`

**Drive primitives**
- `prompt_session(sessionId, prompt, { images? })` — fires the inner agent; returns immediately
  with a handle (async, never blocks)
- `interrupt_session`, `fork_session`, `archive_session`, `reset_session`
- On `requires_action`: `get_pending_action(sessionId)` → `resolve_action(sessionId, decision,
  { remember? })` or `escalate_to_user(sessionId, request)` (per autonomy mode)

**Observe primitives** (efficient, decision-free)
- `project_overview(projectId)` — one call: repos, worktrees, every session with execution
  state + change summary + *needs-attention* flag. The "where am I" / status-digest call,
  instead of many `list_*` reads.
- `find_sessions({ query?, projectId?, repoId?, branch?, status?, provider?, includeHidden?,
  limit, cursor })` — DB-backed lookup so the agent can locate a session on its own by **name
  or structured attributes** (branch, status, provider, project) and recency. Cheap (instant
  cost class), paginated. Returns session handles (id, name, branch, state, last-activity,
  `deepLink`). To find a session by **content**, narrow with `find_sessions` first, then
  confirm with `read_session`/`ask_session` (there is no transcript content index yet — see
  *Gaps to build*).
- `session_status` (one-shot), `await_session_event(sessionIds[], { until, timeout })` (bounded
  wait, wakes on `completed | requires_action | failed`)
- `read_session`, `ask_session` (below); change-review / file / text search

**Human-channel primitives**
- `show_user(target, { focus? })` / `notify_user(message, target)` — resolve an entity (session,
  PR, diff, worktree…) to a deep link and surface it in the agent panel. e.g.
  `show_user(session)` lets the agent say "open this session for me to look at": a notification
  with an **Open** action that navigates to `/sessions/:id` on click (passive), or — with
  `focus: true` — actively opens/focuses the session tab without a click (use sparingly; it
  interrupts the user's current view). Backed by the notification/elicitation channel (see
  *Gaps to build*); the frontend already has the routes + `TabService` to navigate.
- `request_approval(step)` blocks a mission step on a decision.

So "do JIRA-123" is the **agent's own** composition — find_or_create_project → assess pool →
create/reuse worktree → create_session → prompt_session → await_session_event → read_session →
`git`/`gh` → request_approval — every step visible, decided by it, and (in Plan mode) listed
for you to approve. Reads follow the cost-class rules in *Tool performance & scoping*. We may
later add *thin* convenience helpers, but primitives are the contract and always the full-power
path — a helper never becomes the only way to do something.

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
    The agent should persist the returned cursor in its mission state so deltas survive
    reconnects (don't rely solely on the per-connection memory).
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
  - **Returns the final assistant message with a bounded wait** — awaits `executionState:
    idle` up to a short cap (~30–60s); if the answer isn't ready it returns `{ running: true,
    forkId }` and the agent polls `session_status(forkId)` then reads the answer. Never blocks
    the MCP call for minutes. The agent gets just the answer — not a transcript — keeping it
    cheap.
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

## Best practices for the agent (surfaced to it)

These are instructions for the agent itself, to produce good results fast:

- **One session per task / sub-task.** Don't pile unrelated work into a single session — long
  context degrades quality and speed. Split independent work into separate sessions (and
  worktrees); they run in parallel. Multi-repo ticket ⇒ one project, a session per repo, with
  explicit ordering when repo B depends on repo A's output.
- **Seed each session with enough context to avoid over-exploration.** A good kickoff prompt
  states: the goal, the relevant files/areas, constraints/acceptance criteria, and links the
  ticket. The explicit task context in the prompt is what matters most; the AI **worktree
  context** is a bonus injected when already `ready` — its generation is async (5–30s), so
  never block the kickoff waiting for it. Aim for the sweet spot: a tightly scoped task *plus*
  enough orientation that it doesn't burn turns searching.
- **Monitor cheaply, interrogate precisely.** Poll with `session_status`; pull transcripts with
  `read_session` (medium + delta + zoom); ask focused questions with `ask_session` instead of
  re-reading whole histories.
- **Reuse before creating.** Take an **Available**/**Yours** worktree from the pool before
  creating a new one; never silently steal an **Others** worktree — escalate.
- **Use the right tool for the layer.** elevenex MCP for elevenex state/orchestration;
  `git`/`gh`/Jira via their own CLI/MCP; keep payloads lean (detail levels, deltas, caps).
- **Respect the autonomy mode** — escalate at destructive decision points; in Plan mode,
  propose the ordered plan before executing.

## Tool performance & scoping

Tools must stay fast at scale (thousands of files, hundreds of branches/worktrees, hundreds of
commits/hour). Every tool falls into a cost class with a matching rule:

- **⚡ Instant (DB reads)** — `list_projects/repos/sessions`, `get_project`, `session_status`,
  todos/scratchpad. Cheap, but still **paginate** (`limit` + `cursor`, small default) to bound
  the token payload, and **require a parent scope** (projectId/repoId) rather than "everything".
- **🟢 Fast & cached** — `git_status` (1.5s cache), `read_session` (delta), branch list (5s
  cache, remote capped at 100), `read_file` (cap bytes / support ranges), `get_worktree_context`
  (returns the cached snapshot). Hit the backend's existing cache/coalescing — don't force fresh
  scans each call.
- **🟡 Scoped search (require query + cap + may take ~1s)** — `text_search` (ripgrep, default
  250 / max 2000, process killed at cap), `file_search` (default 100 / max 500), `change_review`
  summary (hard cap 2000 files, 60-min cache; summary-first, per-file diff lazy via windowed
  zoom). **Reject empty/pathological queries** (e.g. `.`), enforce small defaults, never return
  unbounded results.
- **🔴 Heavy → async job + poll, never a blocking call** — `create_worktree` (already jobId),
  `generate_worktree_context` (LLM, ~5–30s; return `generationStatus`, serve cached when
  `ready`), `ask_session`/`prompt_session` (model run — bounded wait then handle), `run_action`.
  These return a handle immediately; progress is polled cheaply or streamed.

**Cross-cutting rules baked into every tool:** mandatory scope + pagination on lists; query
required + capped on searches; summary-first with detail-on-demand (zoom); local-first (no
network unless explicitly asked, e.g. remote branches); bounded output (truncate with a "narrow
your scope" hint rather than dumping); reuse in-flight coalescing so parallel sessions don't
launch duplicate work.

**One backend hotspot to fix before exposing it:** the **worktree-pool** listing is currently
unbounded and does a `git status` + `realpath` + several DB queries **per worktree** — fine for
a handful, slow at hundreds. Before wrapping it: add a cap/pagination, prefer the existing
streaming endpoint, and cache per-worktree status briefly (a few seconds). The agent should
also scope pool queries (e.g. only **Available**/**Yours**, limited count) rather than asking
for the full pool.

## Flagship use cases

- **"Do JIRA-123"** — full ticket → project → repos → worktrees → sessions → PRs → review.
- **"Create project X with repos Y and Z"** — straightforward setup.
- **Status digest** — what's active, what needs review, what's blocked on a permission, what
  has red CI (one `project_overview` call).
- **Multi-repo orchestration** — one ticket across several repos, with ordering (repo A's
  output feeds repo B's prompt).
- **CI babysitter** — watch checks; on failure auto-prompt the session to fix.
- **Review-comment handler** — pull PR review comments and address them in-session.
- **Worktree hygiene** — find & clean stale/merged worktrees.
- **Jira write-back** — move ticket status, comment with the PR link.
- **Recurring jobs** — e.g. "every morning, triage my open PRs."
- **Conflict resolver** — detect conflicts, spawn a session to resolve.

## Gaps to build

- **Notification / elicitation channel** — only toasts + websockets exist today; build the
  agent→human "look at this / approve this" path.
- **Finer deep links** — open a specific panel/PR/diff, not just a page.
- **Mission persistence** — reuse/extend `agent-control` so missions survive reloads and are
  resumable.
- **Worktree-pool perf** — cap/paginate the listing and cache per-worktree `git status` so the
  pool tool stays fast at hundreds of worktrees (see Tool performance & scoping).
- **Session search** — a DB-backed `find_sessions` (name + attributes) is easy and missing
  today. Searching session **content** needs a transcript full-text index (SQLite FTS5 fits the
  better-sqlite3 stack); until then the agent narrows by metadata then reads to confirm.

## Open questions

- How does the inner session's permission prompts route — always to the outer agent, always to
  the human, or per autonomy mode?
- Where does the agent's own model/runtime config live (per user? per project?).
- Concurrency limits — how many parallel inner sessions before we throttle.
