# Elevenex Agent — MCP Server & Agent Panel

## Context

`ELEVENEX_AGENT.md` specifies a **meta-agent** that operates elevenex from prompts ("do JIRA-123"):
it sets up projects/repos/worktrees/sessions, triggers inner coding sessions, watches transcripts,
drives git/GitHub, and escalates to the human. The agent's brain runs as a normal Claude session
(in the hidden `~/.elevenex/agent` workspace, driven from the right-side agent panel). What it lacks
is a **tool surface** to observe and operate elevenex's own state. That surface is an **Elevenex MCP
server** that wraps the existing domain services as MCP tools.

Today: the agent panel + `agent-chat` UI exist and run a plain Claude session; the backend has all the
domain services (projects/repos/sessions/worktrees/transcripts) but **no MCP server** and no way for the
inner agent to call them. This plan builds the MCP base, wires it into the agent session, then adds the
tool groups and panel UX **task by task** (granular primitives, never bundled workflows — per the spec).

Architecture is **in-process**: tools inject and reuse the existing NestJS services (no loopback HTTP),
exposed over a **Streamable HTTP MCP server** mounted on the existing NestJS HTTP server. "One tool
surface, many clients" (in-app panel + external MCP clients + Agent SDK + codex).

## Key decisions (resolved)

- **Transport**: `@modelcontextprotocol/sdk` `McpServer` + `StreamableHTTPServerTransport`, mounted as a
  raw Express route at `/api/mcp`, registered in the **pre-body-parser block** of `main.ts` (next to the
  existing `mcp-auth-proxy` at `main.ts:185`) so the transport reads the raw request stream. One
  `McpServer`+transport per `Mcp-Session-Id`; `GET /api/mcp` is the SSE notify channel.
- **Per-agent-session identity (refined, low-risk)**: do **not** change the agent session's cwd. Instead:
  - Add a nullable `mcpAgentToken` column to `sessions`; mint a token when an **agent** session is created.
  - Write a **shared** `~/.elevenex/agent/.mcp.json` with an `http` entry whose auth header uses env
    expansion: `"Authorization": "Bearer ${ELEVENEX_AGENT_TOKEN}"` (Claude Code expands `${VAR}` in
    `.mcp.json`). Inject a per-session `ELEVENEX_AGENT_TOKEN` into the inner process `env` (the option
    builder already sets `env:` per session in `claude-runtime.service.ts`).
  - MCP server reads the bearer token → resolves `agentSessionId` via a registry → routes human-channel
    tools to that session's panel and keeps `read_session` delta cursors per connection. Tokenless
    connections = anonymous external clients (reads allowed, human-channel/destructive degraded).
- **Services reused in-process** (inject, don't re-HTTP): `ProjectsService`, `ReposService`,
  `SessionsService` (+ `SessionForksService`, `PlanChatForksService`), `WorktreePoolService` +
  `WorktreeCreationJobsService`, `WorkspacesService`, `GitService`, `ChangeReviewService`, `FilesService`,
  `ActionsService`, `TodosService`, `ScratchpadService`, `WorktreeContextService`,
  `AgentRuntimeRegistryService`, `ConversationExportService`, `ElevenexAgentService`.
- **MCP module is downstream-only** (it consumes those modules; nothing consumes it) → no new circular
  deps. `mcpAgentToken` minting lives in a tiny leaf service to avoid an `ElevenexAgentModule ↔ McpModule` cycle.

## Cross-cutting principles — prompting, token economy, effectiveness, speed

These are **first-class acceptance criteria for every tool**, not afterthoughts. The agent's quality is
bounded by how well the tools are described, how few tokens each call costs, and how fast they return.

**Best prompting practices (tool descriptions + server instructions)**
- Each tool's `description` is written **for the model**: one tight sentence on *what it does and when to
  reach for it*, the cost class, and an explicit *use-instead* pointer (e.g. "for git use the `git` CLI,
  not this"). Name the **next tool** in the chain so the agent composes primitives correctly.
- Param schemas are self-documenting: every field has a `.describe()` with units, defaults, and caps; enums
  over free strings; required scope params (`projectId`/`repoId`) marked required so the model can't omit them.
- Server `instructions` carry the elevenex object-model primer + best practices once, so individual tool
  descriptions stay short (don't repeat the domain model in every tool).
- Results include a short `nextStep` hint so the model knows the idiomatic follow-up without re-reading docs.

**Token economy (minimize tokens per call — the defaults encode discipline)**
- **Summary-first, detail-on-demand**: lists/reads return compact handles (id, name, status, `deepLink`,
  last-activity) — never full objects. Deep content (transcripts, diffs) only via explicit zoom (`ids`,
  file window).
- **Delta by default**: `read_session` returns only items since the per-connection cursor; unchanged →
  "no new items". Cursor returned so stateless clients pass it back.
- **Poll cheap, read expensive rarely**: `session_status` (counts/state, no render) gates whether to call
  `read_session`; `ask_session` returns *just the answer*, not a transcript.
- **Bounded output**: hard caps with truncation + a "narrow your scope" hint rather than dumping; small
  pagination defaults (`limit` default 25–50, capped). Aggregate reads (`project_overview`) replace many
  `list_*` round-trips. Result envelopes are terse JSON, not prose.
- Tool **outputs are pre-shaped for the model**: only fields the agent acts on; drop internal/DB noise.

**Effectiveness (the agent can actually drive them well)**
- **Granular primitives, never bundled workflows** (per spec): each tool does one accountable thing;
  the agent composes. Keeps Plan mode legible and precise requests possible.
- **Idempotent / find-or-create** by natural identity (project name, repo path, repo+branch) so re-runs
  and resumed missions don't duplicate.
- **Structured errors with remediation** (`{code, message, remediation, retryable}`) so the model
  self-corrects ("branch exists → reuse or rename") instead of guessing.
- **Ready-to-use results**: every mutating tool returns the ids/handles it touched + `deepLink` so the
  agent never rebuilds URLs or re-fetches to learn what it just did.

**Speed (fast at scale — thousands of files, hundreds of worktrees/branches, hundreds of commits/hr)**
- Honor each tool's **cost class** and the matching rule: ⚡instant DB reads (paginate + require scope);
  🟢fast+cached (reuse the existing 1.5s git-status / 5s branch / change-review 60-min caches — never force
  fresh scans); 🟡scoped search (require query + cap, kill ripgrep at cap, reject `.`/empty); 🔴heavy →
  async job + poll, never a blocking MCP call (`create_worktree`, `generate_worktree_context`,
  `prompt_session`, `ask_session`, `run_action`).
- **In-flight coalescing**: reuse the backend's existing request-coalescing so parallel agent calls don't
  launch duplicate work; cancellation/stale-response guards on refreshes.
- **Fix the worktree-pool hotspot before exposing it** (unbounded git-status+realpath+N DB queries per
  worktree): cap/paginate, prefer the existing streaming endpoint, cache per-worktree status briefly, and
  let the tool scope to Available/Yours with a small count.
- **Event-driven over polling**: `await_session_event` wakes on change instead of status loops.

The tool-registry wrapper enforces the mechanical parts of the above (pagination defaults, empty-query
rejection, cost-class guards, envelope shaping) so individual tools can't regress them.

## File layout (backend `apps/backend/src/mcp/`)

```
elevenex-mcp.module.ts
transport/elevenex-mcp-http.transport.ts   # raw req/res, Mcp-Session-Id map, SSE GET, DELETE teardown
transport/mcp-server.factory.ts            # builds McpServer (instructions + registerAll)
connection/mcp-connection-registry.service.ts  # connId/Mcp-Session-Id -> {agentSessionId|null, caps}
identity/mcp-agent-token.service.ts        # leaf service: token <-> agentSessionId (DB-backed)
tool-registry/tool.types.ts               # ToolDefinition, ToolContext, ToolResultEnvelope, ToolError
tool-registry/tool-registry.service.ts    # registerAll(server, ctxFactory); zod->jsonschema; envelope mapping
tool-registry/mcp-tool-services.ts        # injectable bag of reused domain services
tool-registry/result-envelope.ts          # envelope/error -> MCP content
tool-registry/delta-cursor.store.ts       # per-connection read_session cursors
human-channel/human-channel.ts            # notify/show/approval/elicitation sink (per connection)
deep-link/deep-link.builder.ts            # /projects/:id, /sessions/:id (+ finer later)
server-instructions.ts                    # "How elevenex works" primer + best practices
tools/index.ts                            # barrel collecting all ToolDefinitions
tools/{observe,setup,drive,human}/*.tool.ts
__tests__/*.spec.ts                       # per-tool unit specs (mock the service bag)
```

**Tool envelope**: every tool returns `{ data, touched?, deepLink?, nextStep? }`; errors throw a
`ToolError { code, message, remediation?, retryable? }`. Cost class (`instant|cached|scoped|heavy`)
is metadata on each tool; the wrapper enforces pagination defaults, rejects empty/pathological searches,
and expects `heavy` tools to return handles (never block).

## Milestones (executed task-by-task; subagents in parallel within a milestone)

### M0 — MCP base (end-to-end vertical slice) ← build first
1. Add `@modelcontextprotocol/sdk` (+ confirm `zod`) to `apps/backend/package.json`.
2. `ElevenexMcpModule`, `mcp-server.factory.ts`, `server-instructions.ts`.
3. `ElevenexMcpHttpTransport` (session map, SSE, DELETE) + mount route in `main.ts` pre-body-parser.
4. `McpConnectionRegistryService` + `McpAgentTokenService` (leaf) + `sessions.mcpAgentToken` column
   (drizzle migration via `pnpm drizzle-kit generate`).
5. Tool-registry skeleton (`tool.types.ts`, `tool-registry.service.ts`, `mcp-tool-services.ts`,
   `result-envelope.ts`, `delta-cursor.store.ts`) + `DeepLinkBuilder`.
6. Wiring: write shared `~/.elevenex/agent/.mcp.json` + `.claude/settings.local.json` (allow
   `mcp__elevenex__*` safe tools) on workspace ensure; mint token on agent session create; inject
   `ELEVENEX_AGENT_TOKEN` into inner env for sessions that have one.
7. Two smoke tools: `project_overview` (instant read) and `find_sessions` (paginated DB read).
8. **Acceptance**: create agent session in UI → `getMcpSnapshot` shows `elevenex` connected → ask
   "what's my project status?" → agent calls `mcp__elevenex__project_overview` → result + deepLink in panel.

### M1 — Observe group
`session_status`; `read_session` (extend `ConversationExportService.export` with `sinceMessageId` + `ids`
+ running/stale guard from provider runtime state — per spec "Backend work to add"); delta-cursor store;
`text_search`/`file_search` (ripgrep caps); `change_review` summary; `read_file`; `get_worktree_context`;
`await_session_event` (registry hook on `completed|requires_action|failed`).

### M2 — Drive group
`prompt_session` (async handle), `interrupt_session`, `fork_session`, `archive_session`, `reset_session`,
`get_pending_action`, `resolve_action`, `set_provider`/`set_model`/`set_permission_mode`.

### M3 — ask_session (hidden `agent_query` fork)
Add `'agent_query'` to `VALID_SURFACES` (`sessions.service.ts:23`) + nav filters; generalize
`PlanChatForksService.submitQuestion` into an **await-until-idle** variant (timeout + cancellation,
parent-idle guard); `ask_session` tool (bounded wait → answer or `{running, forkId}`).

### M4 — Setup group
`find_or_create_project`, `add_repo`/`remove_repo`, `assess_worktree_pool` (after perf fix: cap/paginate +
brief per-worktree git-status cache), `create_worktree` (async job + poll), `link_worktree`,
`steal_worktree` (destructive → escalation), `set_*`.

### M5 — Human channel + Agent panel UX
Backend notification/elicitation channel (new WS/event path); `notify_user`/`show_user`/`request_approval`/
`escalate_to_user`; finer deep links. Frontend: live mission/step tree in the agent panel, deep links per
step, escalation approval UI, autonomy-mode selection (Full/Review/Plan), follow surface — built on the
existing `agent-control` + `agent-chat` components, `TabService`, `NavigationService`, `ngx-sonner`, Zard UI.

### M6 — Persistence & flagship flows
Mission persistence (extend `agent-control`); optional SQLite FTS5 transcript content index for session
search; flagship compositions (CI babysitter, review-comment handler) validated as agent prompts, not new tools.

## Deferred product decisions (resolve when reached, defaults noted)
- Inner-session permission routing: default **per autonomy mode** (Review destructive escalates).
- Agent model/runtime config location: default **per user** (reuse existing settings).
- Concurrency cap on parallel inner sessions: default soft cap, surfaced as guidance in instructions.

## Critical files to touch
- `apps/backend/src/main.ts` (~line 281): mount `/api/mcp` route pre-body-parser.
- `apps/backend/src/elevenex-agent/elevenex-agent.service.ts`: write `.mcp.json`/settings, mint token.
- `apps/backend/src/database/schema/sessions.schema.ts` (+ generated migration): `mcpAgentToken`.
- `apps/backend/src/claude-runtime/claude-runtime.service.ts` (~4046-4086): inject `ELEVENEX_AGENT_TOKEN` env.
- `apps/backend/src/agent-runtime/conversation-export.service.ts`: `sinceMessageId`/`ids` + running guard (M1).
- `apps/backend/src/sessions/{sessions.service.ts,plan-chat-forks.service.ts}`: `agent_query` + await-ask (M3).
- New tree under `apps/backend/src/mcp/`.
- Frontend `apps/frontend/src/app/features/agent-control/**` for M5 panel UX.

## Verification
- **Build/typecheck**: `pnpm --filter backend build` (or `nest build`); `pnpm --filter frontend build`.
- **Unit**: per-tool specs under `src/mcp/__tests__` (`pnpm --filter backend test`), mocking the service bag.
- **End-to-end (M0)**: start app (`pnpm start:dev`/`start:prod`), open the agent panel, create a session,
  confirm `GET /api/sessions/:id/claude/mcp` lists `elevenex` as connected, prompt the agent and watch it
  invoke `mcp__elevenex__project_overview` with a rendered deepLink result in the panel.
- Each later milestone: add its tools, typecheck, unit-test the new tools, then drive them through a real
  agent session in the panel.

