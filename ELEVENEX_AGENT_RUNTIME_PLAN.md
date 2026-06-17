# Elevenex Agent — Runtime & End-to-End Plan ("the brain")

## 0. Read this first — you have no prior context

This plan makes the **Elevenex Agent** actually work. Today the *tool surface* and the *panel UI*
exist, but **nothing thinks**: the right-side agent panel generates "missions" from keyword
templates (`prompt.includes('project')` → canned steps) and never calls an LLM. This plan builds the
missing **outer-agent runtime** — a real Claude session that reads the user's prompt, plans, and
drives elevenex through the MCP tools — and wires the panel to it, end to end.

Two companion docs describe intent (read them, they're short):
- `ELEVENEX_AGENT.md` — product vision: a meta-agent that operates elevenex from prompts
  ("do JIRA-123"), sets up projects/repos/worktrees/sessions, drives them, escalates to the human.
- `ELEVENEX_AGENT_PLAN.md` — the plan for the MCP server (already built; see §1).

### What already exists (built, tested, on disk — do not rebuild)

**Backend — Elevenex MCP server** at `apps/backend/src/mcp/` (`pnpm --filter backend jest src/mcp` →
79 passing; see `apps/backend/src/mcp/README.md`):
- Streamable-HTTP MCP server mounted at `POST/GET/DELETE /api/mcp` (pre-body-parser in `main.ts`),
  one server+transport per `Mcp-Session-Id`. 37 tools across groups:
  - **Observe**: `project_overview`, `find_sessions`, `session_status`, `read_session` (delta
    cursors), `text_search`, `file_search`, `read_file`, `change_review`, `get_worktree_context`,
    `await_session_event`.
  - **Setup**: `find_or_create_project`, `add_repo`, `remove_repo`, `assess_worktree_pool`,
    `create_worktree` (async job), `get_worktree_job`, `link_worktree`, `steal_worktree`
    (destructive), `create_session` (bridges provisioning → driving), `generate_worktree_context`,
    `set_todo`, `set_scratchpad`.
  - **Drive**: `prompt_session`, `interrupt_session`, `fork_session`, `archive_session`,
    `reset_session` (destructive), `get_pending_action`, `resolve_action`, `set_provider`,
    `set_model`, `set_permission_mode`.
  - **Ask**: `ask_session` (hidden `agent_query` fork → just the answer).
  - **Human channel**: `notify_user`, `show_user`, `request_approval`, `escalate_to_user` (all
    `requiresAgent`; block on a real human via the panel).
- **Tool contract** (`apps/backend/src/mcp/tool-registry/tool.types.ts`): every tool is a
  `defineTool({ name, description, costClass, inputShape, mutates?, destructive?, requiresAgent?,
  handler })`; handler returns `{ data, touched?, deepLink?, nextStep? }`; throws
  `ToolError { code, message, remediation?, retryable? }`. The registry (`tool-registry.service.ts`)
  enforces capability gating, pagination caps, empty-query rejection, and terse-envelope shaping. The
  full tool list is the array `ALL_TOOLS` in `apps/backend/src/mcp/tools/index.ts` (group barrels:
  `tools/{observe,setup,drive,ask,human}/index.ts`).
- **Identity**: `sessions.mcpAgentToken` column (migration `apps/backend/drizzle/0022_*.sql`).
  `McpAgentTokenService` (`mcp/identity/`) mints/resolves it. `claude-runtime.service.ts`
  (`withAgentToken`, ~line 4090) injects `ELEVENEX_AGENT_TOKEN` into the inner process env for
  sessions that have a token. The MCP server resolves the bearer → agent session id → caps.
- **Human channel transport**: `AgentHumanChannelService` (`mcp/human-channel/human-channel.ts`,
  an EventEmitter with `notify/show/requestApproval` + `resolveApproval` + `pendingApprovals()`) and
  `AgentChannelGateway` (`mcp/human-channel/agent-channel.gateway.ts`, raw WS at **`/agent-channel`**,
  attached in `main.ts`). It streams `notification`/`show`/`approval`/`approval_resolved` and accepts
  `{ type:'resolve_approval', id, decision, note? }`.
- **Agent workspace bootstrap**: `ElevenexAgentService`
  (`apps/backend/src/elevenex-agent/elevenex-agent.service.ts`, `OnModuleInit`) writes
  `~/.elevenex/agent/.mcp.json` (an `http` server `elevenex` → `http://127.0.0.1:<proxyPort>/api/mcp`
  with header `Authorization: Bearer ${ELEVENEX_AGENT_TOKEN}`) and `~/.elevenex/agent/.claude/
  settings.local.json` (`enableAllProjectMcpServers:true` + an allow-list of the safe read-only
  elevenex tools). So a Claude process whose **cwd is `~/.elevenex/agent`** auto-connects to the
  elevenex MCP server as whatever agent session its `ELEVENEX_AGENT_TOKEN` identifies.

**Frontend — agent panel** at `apps/frontend/src/app/features/agent-control/`:
- `agent-control-drawer.component.{ts,html,scss}` (selector `app-agent-control-drawer`, mounted in
  `app.html`), driven by `agent-control-state.service.ts` (signals; localStorage-persisted **mock**
  missions via keyword inference — **this is what we replace**). Sub-components:
  `components/{autonomy-selector,step-row,mission-tree,escalation-card,live-escalation-card}`.
- `agent-channel-websocket.service.ts` — connects to `/agent-channel`, exposes
  `liveApprovals: Signal<…>` + `connected: Signal<boolean>`, `resolveApproval(id, decision, note?)`,
  `openDeepLink(deepLink)`. Already wired; keep it.

### The gap this plan closes

There is **no agent session and no runtime**. Nothing creates a Claude session that uses the 37
tools; the panel's "plans" are templates. We will: (A) create real agent sessions in
`~/.elevenex/agent`, (B) give them a perfect meta-agent system prompt + autonomy-aware permission
policy, (C) expose a small backend "missions" API, and (D) rebuild the panel to render the live agent
session (reusing the existing session transcript components) so a mission runs and completes end to
end. (The previously-missing `create_session` MCP tool — the bridge from provisioning to driving —
**is now built**; see §5.)

---

## 1. Architecture & key decisions (resolved — these are the defaults; follow them)

**D1 — A mission IS an agent session.** Each mission = one elevenex *session* with the new surface
`'agent'`, cwd `~/.elevenex/agent`, provider `claude`. This reuses the entire session lifecycle
(create/start/submitPrompt/history/runtime-state/persistence) and gives mission persistence for free
(sessions live in SQLite). The panel lists missions by listing `surface:'agent'` sessions.

**D2 — Reuse the existing runtime; do not build a new one.** The agent session runs through the
existing `claude-runtime`/`agent-runtime` machinery. `submitPrompt` spawns the Claude SDK `query()`
with `cwd: ~/.elevenex/agent`; the SDK auto-loads that dir's `.mcp.json` + `settings.local.json`
(via `settingSources: ['project','user','local']`, already set in `buildQueryOptions`), so the agent
connects to the elevenex MCP server automatically and authenticates with the injected token.

**D3 — Hidden synthetic project/repo for the workspace.** Sessions require a `repoId` (FK), and
`ReposService.addRepo` requires the path to contain `.git`. So: `git init ~/.elevenex/agent`, then
find-or-create a hidden project **"Elevenex Agent"** + repo pointing at `~/.elevenex/agent`. Agent
sessions bind to that repoId. They stay hidden because nav/lists filter `surface='session'`.

**D4 — System prompt via preset append.** The SDK `Options.systemPrompt` supports
`{ type:'preset', preset:'claude_code', append: string }`. For `surface:'agent'` sessions,
`buildQueryOptions` appends the **meta-agent prompt** (§3) with the mission's autonomy clause. Normal
sessions are unchanged.

**D5 — Autonomy modes map to permission policy** (`'full' | 'review' | 'plan'`, default `'review'`),
stored per agent session and enforced in `claude-runtime`'s `canUseTool`:
- **full** → `permissionMode: 'bypassPermissions'`; all elevenex tools auto-allowed (incl.
  destructive). Agent runs end-to-end; still told to `notify_user` at milestones.
- **review** (default) → safe elevenex tools auto-allowed (workspace `settings.local.json` already
  does this); **destructive** elevenex tools (`steal_worktree`, `reset_session`, `remove_repo`, +
  any future push/PR tools) produce a **permission request** that surfaces in the panel for the human
  to approve/deny. The system prompt also instructs the agent to `request_approval` before
  real-world risky actions.
- **plan** → `setPlanMode(true)`; the agent presents an ordered plan and blocks (existing plan-mode /
  ExitPlanMode flow + plan-annotator UI); after the human approves, it proceeds as **review**.

**D6 — The panel renders the real session, not a mock.** Replace the template mission engine. The
drawer shows: a **mission list** (agent sessions), and for the selected mission a **live transcript**
(reuse `cw-message`/`cw-thinking`/`cw-tool-call`/`cw-permission-inline` from
`features/session/claude-workspace/components/`) + a **composer**, **plan panel**, **autonomy
selector**, and the **escalations** already wired via `/agent-channel`. The **step tree** is derived
from the agent's real `TodoWrite` plan (rendered from transcript `tool-todos`) — not invented.

**D7 — `create_session` MCP tool (BUILT).** The e2e ("spin up sessions and prompt them") requires
creating an inner coding session; there was no tool for it (only worktree link/create). It is now
implemented in the Setup group — `apps/backend/src/mcp/tools/setup/create-session.tool.ts`, exported
from `tools/setup/index.ts`, covered in `__tests__/setup.spec.ts` (37 tools, 79 tests green). See §5
for its contract; the runtime/panel milestones below treat it as available. (A Git/GitHub tool group
and Jira remain optional extensions in §11 — the minimal working e2e does not need them, because
inner sessions do their own git via prompts.)

**D8 — Model.** Default the agent session to a capable model from user settings (`SettingsService`);
fall back to the runtime default. Configurable per mission via the existing `setSelectedModel`.

---

## 2. Confirmed integration facts (so you don't re-derive them)

Backend:
- `SessionsService.create(dto)` — `apps/backend/src/sessions/sessions.service.ts:48`. DTO:
  `{ repoId: number(required); workspaceId?; branchName?; worktreePath?; name?; surface?;
  activeAgentProvider? }`. No workspace/worktree-on-disk required; `worktreePath` is just the cwd.
  `VALID_SURFACES` is at line 23 (currently `['session','embedded_plan_chat','agent_query']`);
  visibility filtering is `visibleWhere()` (~line 925) keying on `surface='session'` — add `'agent'`
  to the const and it is automatically hidden everywhere (navigation tree calls `findByRepo` without
  `includeHidden`).
- `SessionsService.start(id)` (~853) flips status to `'active'`; the SDK process is spawned lazily on
  first `submitPrompt`. `ProjectsService.create(name)`; `ReposService.addRepo(projectId, path)`
  validates dir + `.git` + unique `(projectId,path)`.
- `claude-runtime.service.ts`: `buildQueryOptions(sessionId, worktreePath, …)` (~4027) sets `cwd`,
  `systemPrompt` (preset claude_code), `settingSources`, and `env` (token already injected via
  `withAgentToken`, ~4090). `createCanUseTool(...)` (~1042–1146) is where tool-use is gated;
  `approvePermission(sessionId, requestId, remember?, content?)` / `denyPermission(sessionId,
  requestId, message?)` (~1881–1924) resolve a pending request; `setPermissionMode(sessionId, mode)`,
  `setPlanMode(sessionId, enabled)`, `setSelectedModel(sessionId, model|null)`. Runtime state exposes
  `runPhase`/`sessionState`/`pendingPermissionRequest`/`pendingUserInputRequest`/`liveItems`. Events
  emitted: `message_start|delta|complete`, `thinking_*`, `tool_use`, `tool_result`,
  `permission_request|resolved`, `user_input_request`, `run_state`, `session_snapshot`,
  `history_snapshot`, `session_metadata`.
- Provider-agnostic access: `AgentRuntimeRegistryService.getProvider('claude')` and
  `getProviderFeature('claude', 'setPermissionMode'|'approvePermission'|…)`.

Frontend:
- Stream: `AgentRuntimeWebsocketService.connect(sessionId, 'claude'): Observable<AgentRuntimeEvent>`
  and `send(sessionId, msg, 'claude')`; `connectionState$(sessionId, provider)`. History/state:
  `AgentRuntimeApiService.getHistory/getRuntimeState/exportConversation`.
- Transcript components (`features/session/claude-workspace/components/`): `cw-message`,
  `cw-thinking`, `cw-tool-call` (renders `tool-todos`, `inline-diff`, `tool-output`),
  `cw-permission-inline` (`@Output approve: {remember,content?}`, `deny: string?`), `cw-composer`
  (`@Output send: { text, images, diffMentions? }`, `interrupt`).
- WS message shapes the workspace sends: `{type:'hydrate'}`; `{type:'submit_prompt', prompt,
  titlePrompt, images?}`; `{type:'approve_permission', requestId, decision:'approved'|
  'approved_always', remember, content?}`; `{type:'deny_permission', requestId, message?}`.
- Plan UI: `features/plan-annotator/plan-annotator-panel.component.ts` +
  `plan-review.model.ts` (`PlanReviewRequest`). Session view wiring: `features/session/
  session-container/session-container.ts` → `claude-workspace.component.ts` (selector
  `app-claude-workspace`, inputs `sessionId`, `repoId`, `activeAgentProvider`, `readOnlyTranscript`).

---

## 3. The meta-agent system prompt (crown jewel — ship this verbatim, then iterate)

Stored as an exported constant `ELEVENEX_META_AGENT_SYSTEM_PROMPT` in a new
`apps/backend/src/elevenex-agent/meta-agent-prompt.ts`, injected as the `append` of the agent
session's `systemPrompt`. The `{{AUTONOMY}}` block is substituted per mission from the modes below.
Keep it tight — the MCP server already sends the object-model primer in its `instructions`, so do not
duplicate the object model here.

```
# You are the Elevenex Agent

You operate **elevenex** — a workbench that orchestrates AI coding sessions across many repos and git
worktrees — for a human, from a single request (e.g. "set up project X with repos Y and Z", or
"add a dark-mode toggle in repo Z"). You are a META-agent: you do NOT write code yourself. You
decompose the request into elevenex setup plus one or more inner coding sessions, trigger those
sessions with prompts, watch their progress, verify the result, and escalate to the human when a
decision is yours to ask for.

## How you act
Everything you do to elevenex is through the `mcp__elevenex__*` tools (already connected to this
session). They are granular primitives — compose them; there is no bundled "do everything" tool. The
MCP server's instructions describe the object model and every tool states its cost and the idiomatic
next call (`nextStep`) — follow those. Do NOT shell out to git/gh or edit files to change elevenex
state; use the tools. (The inner coding sessions you spawn DO use git and edit files inside their own
worktrees — you steer them with prompts, you don't do their work.)

## The loop (compose these primitives)
1. ORIENT — call `project_overview` first to see current state. Never guess ids; get them from tools.
2. PLAN — form a short, ordered plan and record it with the TodoWrite tool so the human can follow
   along. Keep it updated as steps complete. {{AUTONOMY_PLAN_CLAUSE}}
3. SET UP — `find_or_create_project` → `add_repo` → `assess_worktree_pool` → `create_worktree`
   (poll `get_worktree_job`) or `link_worktree` → `create_session`.
4. DRIVE — `prompt_session` to start/continue inner coding work; it returns immediately (it does NOT
   wait for the reply). Then WATCH efficiently: `await_session_event` to sleep until the session
   completes or needs action; `session_status` for a cheap poll; only `read_session` (a delta) when
   there are new items. Resolve an inner session's permission prompts with `get_pending_action` →
   `resolve_action`, within your autonomy mandate.
5. VERIFY — `change_review` to inspect the diff; `read_file` to look closer; `ask_session` for a
   quick question about the work without reading the whole transcript.
6. COMMUNICATE — `notify_user` for progress/FYI; `show_user` to surface something to look at;
   `request_approval` to block on a yes/no decision; `escalate_to_user` to block on an open question.
   Always pass a `sessionId`/`projectId` so the human's notification has an "Open" deep link.
7. FINISH — when the mission is complete, `notify_user` a concise summary (what you did, links) and
   stop. If you cannot finish, escalate with exactly what you need.

## Cost & speed discipline
You are billed per token and per second; elevenex holds thousands of files and hundreds of worktrees.
Tools return compact handles — do not ask for or echo full dumps. Prefer `await_session_event` over
tight polling loops. Heavy tools (`create_worktree`, `prompt_session`, `ask_session`,
`generate_worktree_context`) return a handle at once — never sit blocking on them. Keep a small
working set; don't re-list what you already know.

## Autonomy mandate — {{AUTONOMY_MODE_NAME}}
{{AUTONOMY_BODY}}

## Working with the human
Escalate deliberately, not constantly. Reserve `request_approval`/`escalate_to_user` for genuine
decisions and the risky actions your autonomy mode withholds from you. For everything else, proceed
and keep the human informed with `notify_user`. If a tool returns an error with `remediation`, follow
it and self-correct rather than asking the human.
```

Autonomy substitutions:
- `full`: `AUTONOMY_MODE_NAME = "Full autonomy"`. `AUTONOMY_BODY = "Act end-to-end, including risky
  and irreversible actions, stopping only when you are genuinely blocked or the request is ambiguous.
  Still notify_user at each milestone so the human can follow along."` `AUTONOMY_PLAN_CLAUSE = ""`.
- `review`: `AUTONOMY_MODE_NAME = "Review destructive"`. `AUTONOMY_BODY = "Set up the environment and
  run inner sessions freely. But you MUST request_approval BEFORE any risky or irreversible action:
  stealing a worktree owned by someone else, resetting/archiving a session, deleting a repo, force
  operations, pushing, and opening or approving PRs. If a tool call is blocked pending approval, that
  is the system asking you to request it — do so with a clear summary and a deep link."`
  `AUTONOMY_PLAN_CLAUSE = ""`.
- `plan`: `AUTONOMY_MODE_NAME = "Plan first"`. `AUTONOMY_BODY = "Operate as Review destructive AFTER
  approval."` `AUTONOMY_PLAN_CLAUSE = "You are in PLAN mode: present your full ordered plan to the
  human and STOP. Do not call any mutating tool until the human approves the plan."` (Plan mode is
  also enforced mechanically via the runtime's plan mode; this clause makes the model cooperate.)

---

## 4. Milestone A0 — Agent workspace, hidden project/repo, `'agent'` surface, autonomy column

**Files:** `sessions.schema.ts` (+ migration), `sessions.service.ts`, `elevenex-agent.service.ts`.

1. **Surface**: add `'agent'` to `VALID_SURFACES` (`sessions.service.ts:23`). Confirm `visibleWhere`
   and every `eq(surface,'session')` query keeps it hidden (mirror how `agent_query` was added).
2. **Autonomy column**: add `agentAutonomyMode text` (nullable) to `sessions.schema.ts`; generate the
   migration with `cd apps/backend && pnpm drizzle-kit generate` and commit it. Add
   `SessionsService.updateAgentAutonomyMode(id, mode)` and include the field in `findOne`.
3. **Workspace repo bootstrap** (extend `ElevenexAgentService`): add
   `async ensureAgentRepo(): Promise<{ projectId: number; repoId: number; worktreePath: string }>`:
   - Ensure `~/.elevenex/agent` exists and is a git repo: if no `.git`, run `git init`, set a local
     `user.name`/`user.email`, create `.gitkeep`, and make one commit (async `execFile`, never
     `execSync`). Idempotent.
   - Find-or-create a project named `"Elevenex Agent"` (via `ProjectsService`) and a repo at the
     expanded `~/.elevenex/agent` path (via `ReposService.addRepo`, catching the unique-conflict and
     reusing). Cache the ids. Keep `ensureWorkspace()` (the `.mcp.json` writer) as-is and call both
     from `onModuleInit`.
   - The "Elevenex Agent" project is hidden from normal UI by convention: agent sessions use surface
     `'agent'` (hidden), and the panel never browses this project. (Optional: filter a project named
     `"Elevenex Agent"` out of the nav tree if it shows up — verify and only add if needed.)

**Acceptance:** backend boots; `~/.elevenex/agent` is a git repo with `.mcp.json` + settings; a
project+repo exist; creating a `surface:'agent'` session does not appear in the navigation tree.

---

## 5. Milestone A1 — `create_session` MCP tool — ✅ DONE

Implemented and shipped. **Files:** `apps/backend/src/mcp/tools/setup/create-session.tool.ts`,
exported from `tools/setup/index.ts`; tests in `apps/backend/src/mcp/__tests__/setup.spec.ts`.
`jest src/mcp` → 79 passing, 37 tools registered. No further work in this milestone; later milestones
use it directly.

**Shipped contract** (Setup group, `costClass:'instant'`, `mutates:true`):
- Args: `repoId` (required), and **either** `workspaceId` (preferred — the natural output of
  `link_worktree`) **or** `worktreePath` + `branchName` (e.g. from a finished `create_worktree` job);
  plus `name?` and `provider?` (enum `claude|codex|pi`, default `claude`).
- Behaviour: validates the repo up front (`repos.findOne` → `ToolError repo_not_found` on miss);
  requires a scope (`ToolError scope_required` if neither `workspaceId` nor `worktreePath+branchName`
  is given); calls `sessions.create({ repoId, workspaceId?, worktreePath?, branchName?, name?,
  surface:'session', activeAgentProvider: provider })`. It does **not** start the session — that
  happens lazily in `prompt_session` (which calls `sessions.start` when the session isn't already
  active). Wraps creation failures as `ToolError create_session_failed` with remediation ("ensure the
  worktree exists on disk — create_worktree/link_worktree first").
- Returns: `{ data: { sessionId, name, repoId, branch, worktreePath, provider, status },
  touched: { sessionId }, deepLink: /sessions/:id, nextStep: "Trigger work with prompt_session, then
  await_session_event / session_status to watch it." }`.

**How the agent uses it (the now-complete provisioning→driving chain):**
`find_or_create_project` → `add_repo` → `assess_worktree_pool` → `link_worktree` (returns a
`workspaceId`) **or** `create_worktree` → `get_worktree_job` (returns a `worktreePath`+branch) →
**`create_session`** (pass the `workspaceId`, or the `worktreePath`+`branchName`) → `prompt_session`
→ `await_session_event`.

---

## 6. Milestone A2 — Meta-agent runtime hooks (system prompt + autonomy permission policy)

**File:** `apps/backend/src/claude-runtime/claude-runtime.service.ts` (+ new
`elevenex-agent/meta-agent-prompt.ts`, + a shared constant of destructive elevenex tool names).

1. **System prompt append** in `buildQueryOptions` (~4072): load the session row (already available
   via the `withAgentToken` lookup — fetch once and reuse). If `session.surface === 'agent'`, set
   `systemPrompt = { type:'preset', preset:'claude_code', append: buildMetaAgentPrompt(autonomyMode) }`
   where `buildMetaAgentPrompt` substitutes the `{{AUTONOMY*}}` blocks from §3. Otherwise leave the
   preset untouched. Read `agentAutonomyMode` from the session (default `'review'`).
2. **Autonomy → permission mode**: when starting/continuing an agent session, set the permission mode
   from autonomy: `full → 'bypassPermissions'`, `review → 'default'`, `plan → 'plan'` (use the
   existing `setPermissionMode`/`setPlanMode` or set it in the options for the first turn). Centralize
   the mapping in a helper `permissionModeForAutonomy(mode)`.
3. **Destructive-tool gating in `createCanUseTool`**: define
   `DESTRUCTIVE_ELEVENEX_TOOLS = new Set(['mcp__elevenex__steal_worktree',
   'mcp__elevenex__reset_session','mcp__elevenex__remove_repo'])` (export from the mcp module or a
   shared constants file; keep it in sync with the tools' `destructive:true` flag — add a short
   comment cross-referencing). In `createCanUseTool`, for `surface:'agent'` sessions:
   - **full** → allow everything.
   - **review** → allow non-destructive automatically; for a tool in `DESTRUCTIVE_ELEVENEX_TOOLS`,
     return the normal "ask" path so a `permission_request` is raised and surfaces in the panel
     (human approves/denies via `cw-permission-inline`). Do not auto-deny — the human decides.
   - **plan** → plan mode already blocks mutations; no special-casing needed beyond the mode.
   Keep non-agent sessions on their current behavior (do not regress normal sessions — guard the new
   logic behind `surface === 'agent'`).
4. The `request_approval`/`escalate_to_user` MCP tools already block via the human channel; nothing to
   add — they now actually fire because a real agent is running.

**Acceptance (unit):** a spec that builds `buildQueryOptions` for a `surface:'agent'` session asserts
the append prompt is present and the permission mode matches the autonomy mode; a `createCanUseTool`
test asserts a destructive elevenex tool in `review` raises a permission request while a safe tool
auto-allows, and `full` allows the destructive one. Guard so normal sessions are unaffected.

---

## 7. Milestone A3 — Backend "missions" API (thin orchestration over agent sessions)

**Files:** new `apps/backend/src/elevenex-agent/elevenex-agent-missions.service.ts` +
`elevenex-agent.controller.ts` + register in a module (extend `ElevenexAgentModule`; it must import
`SessionsModule`, `ProjectsModule`, `ReposModule`, the MCP module's `McpAgentTokenService`, and the
agent runtime). This is the only place that knows "mission == agent session"; keep it thin — it
composes existing services, it does not reimplement them.

Service methods:
- `async createMission({ prompt, autonomyMode = 'review', model? }): Promise<MissionHandle>` —
  `ensureAgentRepo()`; mint nothing manually (the token is minted by `McpAgentTokenService.ensureToken`
  on create); `sessions.create({ repoId, worktreePath, branchName:'main', surface:'agent',
  activeAgentProvider:'claude', name: deriveTitle(prompt) })`; `tokenService.ensureToken(sessionId)`;
  `updateAgentAutonomyMode(sessionId, autonomyMode)`; set model if provided; `sessions.start(id)`;
  then `getProvider('claude').submitPrompt(sessionId, prompt)`. Return `{ sessionId, deepLink }`.
- `async listMissions(): Promise<MissionSummary[]>` — `sessions.findAll({ includeHidden:true })`
  filtered to `surface:'agent'`, mapped to compact summaries (id, title, status, autonomyMode,
  lastActivityAt). (Add a `findBySurface('agent')` helper to `SessionsService` if cleaner.)
- `async setAutonomy(sessionId, mode)`, `async interruptMission(sessionId)` (provider.interrupt),
  `async archiveMission(sessionId)` (sessions.archiveAndStop). Continuation prompts reuse the normal
  `submit_prompt` WS path (no new endpoint needed — see A4).

Controller (`/api/agent/missions`): `POST` (create), `GET` (list), `GET /:id`, `POST /:id/autonomy`,
`POST /:id/interrupt`, `POST /:id/archive`. DTOs with `class-validator` (the app uses a global
`ValidationPipe`). Keep payloads small.

**Acceptance:** `POST /api/agent/missions {prompt:"…"}` creates a hidden agent session, mints a token,
starts it, submits the prompt, and returns `{sessionId, deepLink}`; `GET` lists it; the session does
not appear in the normal navigation tree.

---

## 8. Milestone A4 — Frontend: render the live agent (replace the mock)

**Goal:** the drawer becomes real mission control. Reuse the session transcript components rather than
re-implementing chat rendering.

**Files (frontend `features/agent-control/`):** rewrite `agent-control-state.service.ts` and
`agent-control-drawer.*`; add `agent-missions-api.service.ts`; reuse from
`features/session/claude-workspace/components/` (`cw-message`, `cw-thinking`, `cw-tool-call`,
`cw-permission-inline`, `cw-composer`) and `AgentRuntimeWebsocketService`/`AgentRuntimeApiService`.
Keep `agent-channel-websocket.service.ts`, `autonomy-selector`, `live-escalation-card`.

1. **`AgentMissionsApiService`** — `HttpClient` wrapper for `/api/agent/missions` (create/list/get/
   autonomy/interrupt/archive). Returns the `MissionSummary`/handle shapes from A3.
2. **State service rewrite** — drop keyword inference and mock steps. Hold: `missions` (from the API),
   `selectedMissionId`, and per-mission **live transcript state** built by subscribing to
   `AgentRuntimeWebsocketService.connect(sessionId,'claude')` and folding the `AgentRuntimeEvent`
   stream into `liveItems` (mirror how `claude-workspace.component` folds events — extract/share that
   reducer if practical, else replicate the minimal subset: message/thinking/tool_use/tool_result/
   run_state/permission_request). On select, send `{type:'hydrate'}`. Expose `runtimeState` signals
   (runPhase, pendingPermissionRequest, planMode) per selected mission.
3. **Drawer layout** (Zard UI + Tailwind, semantic tokens, light+dark, a11y per `AGENTS.md`):
   - **Header**: context label, `/agent-channel` connected pill, active-mission count.
   - **New-mission composer** (when no mission selected, or a "＋ New mission" affordance): a textarea
     + the **autonomy selector** (Full/Review/Plan) → calls `missionsApi.create({prompt, autonomyMode})`,
     then selects the new mission.
   - **Mission list**: each mission row = title, status pill (derive from runPhase/sessionState:
     running=primary-animated, waiting_approval=warning, complete=success, error=destructive,
     idle=muted), relative time, autonomy chip. Click selects.
   - **Selected mission view**: 
     - **Step tree** (keep `mission-tree`/`step-row` visually, but feed it the agent's real plan):
       derive steps from the latest `TodoWrite` tool call in the transcript (the `cw-tool-call`
       `tool-todos` data) — todo text → step label, todo status → step status. If no TodoWrite yet,
       show "Planning…". Each step deep-links if its text references a session/project the agent
       touched (best-effort; optional).
     - **Live transcript**: render `liveItems` with the reused `cw-*` components (read-only-ish; the
       composer below handles input). Show `cw-thinking` collapsed, `cw-tool-call` for each MCP tool
       call (these are the agent's actions — `mcp__elevenex__*` calls render with name + compact
       input/result), `cw-permission-inline` for any `pendingPermissionRequest` (a destructive tool in
       Review mode), wired to send `approve_permission`/`deny_permission` over the same WS.
     - **Plan panel**: if a plan/`enter_plan_mode` appears (Plan autonomy), mount the existing
       `plan-annotator-panel` (or a compact inline approve/deny) and send the approval over WS.
     - **Composer**: a slim `cw-composer` (or a textarea) that sends follow-up prompts via
       `AgentRuntimeWebsocketService.send(sessionId,{type:'submit_prompt',prompt,titlePrompt},'claude')`;
       Cmd/Ctrl+Enter; interrupt button when running.
   - **Escalations**: keep the `live-escalation-card` section fed by `/agent-channel`
     (request_approval/escalate_to_user now actually arrive). Approve/deny calls
     `agentChannelWs.resolveApproval(...)`.
4. **Deep links**: notifications/escalations carry `deepLink` (`/sessions/:id`, `/projects/:id`);
   reuse `AgentChannelWebsocketService.openDeepLink` and `NavigationService`/`TabService` so "Open"
   jumps to the inner session/project. The agent panel itself stays open as the follow surface.

**Design rules (must follow `AGENTS.md`):** Zard components (`z-button`, `z-card`, `z-input`,
`z-skeleton`, `z-accordion`), Tailwind utilities, semantic tokens only (no literal colors), verify
light+dark, focus rings, hover/active/disabled/empty/loading/error states. Split components by
responsibility; keep templates/styles in their own files.

**Acceptance:** typing a prompt creates a real mission; the panel streams the agent's thinking + MCP
tool calls live; a plan (Plan mode) renders and is approvable; a destructive action (Review mode)
shows a permission prompt that, when approved, unblocks the agent; the agent's `notify_user` shows a
toast with a working "Open" link. `pnpm --dir apps/frontend build` passes.

---

## 9. Milestone A5 — End-to-end wiring, autonomy correctness, polish

- **Plan-mode round trip**: confirm the `plan` autonomy path produces a plan, blocks, and resumes on
  approval, reusing the existing plan-annotator/ExitPlanMode flow. Verify the resumed agent switches to
  Review behavior.
- **Mission status lifecycle**: derive mission status from runtime state + completion; mark complete
  when the agent ends its turn idle and has sent a final `notify_user`. Persist via the session row.
- **Concurrency guidance**: the system prompt already nudges a small working set; optionally surface a
  soft cap on simultaneous inner sessions in the prompt (default soft cap, guidance only).
- **Error/empty/reconnect states** in the panel; reconnect re-hydrates; interrupted/failed missions
  are clearly shown and resumable (send a new prompt).

---

## 10. Verification — including the real end-to-end test (the bar M0 never met)

- **Build/typecheck**: `pnpm --filter backend build`; `pnpm --dir apps/frontend build`.
- **Unit**: `pnpm --filter backend jest src/mcp src/elevenex-agent` (create_session tool, autonomy
  prompt/permission helpers, missions service with a mocked bag). Frontend: state-reducer spec for the
  event→liveItems fold; component specs for the mission list + permission wiring.
- **End-to-end (do this — it is the acceptance bar):** start the app (`pnpm backend:dev` +
  `pnpm frontend:dev`, or the electron/dev-tmux flow). Open the agent panel. Run, in **Plan** mode:
  *"Create a project called Demo, add the repo at <some local git repo>, then summarize its codebase."*
  Expect: the agent presents an ordered plan → you approve → it calls `project_overview`,
  `find_or_create_project`, `add_repo`, `generate_worktree_context`/`get_worktree_context`, and
  `notify_user`s a summary with a deep link; the project appears in the nav tree (the inner one, not
  the hidden agent project); the panel shows the live tool calls. Then run, in **Review** mode, a
  mission that triggers a destructive tool (e.g. ask it to reset a session) and confirm a permission
  prompt appears in the panel and approving it unblocks the agent. Confirm `GET /api/sessions/:id/
  claude/mcp` for the agent session lists `elevenex` as **connected**.
- Capture a short screen recording / screenshots of a mission running for the PR.

---

## 11. Deferred / optional extensions (clearly out of the minimal e2e scope)

Resolve when reached; not required for a working agent:
- **Git/GitHub MCP tool group** — `git_status`, `commit` (suggested message), `push`,
  `get_pull_request`, `pr_checks`, `pr_comments`, `comment_pr` over the existing `GitService` +
  `GithubService` (`apps/backend/src/github/github.service.ts`: `getPullRequest`,
  `getPullRequestConversation`, `getPullRequestChecks`, `addComment`). Needed for the CI-babysitter and
  review-comment flagship flows. Add as a `tools/git/` group; mark push/PR-write destructive (escalate
  in Review).
- **Jira integration** — no Jira in the backend today; add a ticket-fetch path (piggyback the existing
  `jira-branch` skill / Jira API) + optional write-back, exposed as MCP tools, to enable literal
  "do JIRA-123".
- **SQLite FTS5 transcript content index** — optional perf for cross-session transcript search
  (`text_search`/`read_session` cover today's needs).
- **Flagship compositions** — CI babysitter, review-comment handler, conflict resolver, recurring
  jobs: validate as agent *prompts/missions*, not new tools, once Git/GitHub + the runtime are in.
- **Multi-provider brain** — allow the agent session to run on codex/pi, not just claude.

## 12. Critical files (touch map)
- `apps/backend/src/sessions/sessions.schema.ts` (+ generated migration) — `agentAutonomyMode`.
- `apps/backend/src/sessions/sessions.service.ts` — `'agent'` surface, `updateAgentAutonomyMode`,
  `findBySurface`.
- `apps/backend/src/elevenex-agent/elevenex-agent.service.ts` — `ensureAgentRepo()`.
- `apps/backend/src/elevenex-agent/{meta-agent-prompt.ts, elevenex-agent-missions.service.ts,
  elevenex-agent.controller.ts}` (new) + `elevenex-agent.module.ts` wiring.
- `apps/backend/src/claude-runtime/claude-runtime.service.ts` — system-prompt append + autonomy
  permission policy in `buildQueryOptions`/`createCanUseTool` (guarded to `surface:'agent'`).
- `apps/backend/src/mcp/tools/setup/create-session.tool.ts` (✅ done) + `tools/setup/index.ts`.
- `apps/frontend/src/app/features/agent-control/**` — state rewrite, missions API, drawer rebuild,
  reuse of `claude-workspace` transcript components.
```
