# Elevenex MCP Server

In-process [Model Context Protocol](https://modelcontextprotocol.io) server that exposes
elevenex's domain services to both coding-session agents and orchestration missions. Agents can
identify their current session and worktree, find related sessions, manage project notes and saved
commands, coordinate other sessions, and reach the human. It is the integration surface described in `ELEVENEX_AGENT.md` / `ELEVENEX_AGENT_PLAN.md`.

## How it's wired

- **Transport**: `@modelcontextprotocol/sdk` `McpServer` + `StreamableHTTPServerTransport`, mounted
  as a raw Express route at `POST/GET/DELETE /api/mcp` in the **pre-body-parser** block of
  `main.ts` (next to the mcp-auth-proxy) so the transport reads the raw request stream. One
  `McpServer`+transport per `Mcp-Session-Id`; `GET` is the SSE notify channel, `DELETE` tears down.
- **Identity**: every coding session and mission lazily receives a stable `mcpAgentToken`.
  Claude, Codex, and OpenCode receive the authenticated HTTP server through runtime configuration;
  Pi receives `ELEVENEX_AGENT_TOKEN` and `ELEVENEX_MCP_URL` through its extension environment.
  Credentials are never written to the coding repository or included in the model prompt.
  Tokens resolve to the calling session, independently of UI focus, and cached identities are
  checked against the database so deleted sessions lose access. Tokenless callers retain reads
  and non-destructive mutations; destructive operations and human-channel tools require identity.
- **Coding session context**: `get_current_session` returns live session/project/repo/workspace
  ids (including taskId/worktreeId), names, task lifecycle, branch, checkout, provider, and plan mode without a transcript or git scan.
  Coding sessions retain their native tools and coding prompts. Missions keep their orchestration
  mandate and autonomy policy. Existing sessions receive the connection when their runtime next
  starts or resumes a turn.
- **Default scopes**: tools opting into `currentSessionScope` allow coding callers to omit
  scope: transcript/status tools use their session; file/diff/context/actions use its worktree;
  notes/todos use its project; task reads, labels, and drafts use its task; repository discovery and task creation use its repo. Explicit scopes take precedence.
  Missions and external clients must still scope calls explicitly. Session-control tools keep
  required targets; `disallowSelfTarget` rejects self prompts/stops, finishing the caller’s task, and deleting or archiving containers that include the caller. File/command scope validates the session’s task checkout before using it, protecting historical paths after reuse.
- **Services reused in-process** (no loopback HTTP): see `tool-registry/mcp-tool-services.ts`.
- **Downstream-only** module: it consumes domain modules and nothing consumes it (no new cycles).

## Layout

```
elevenex-mcp.module.ts            wiring (imports domain modules, provides the server)
transport/                        Mcp-Session-Id map + SSE/DELETE; McpServer factory
connection/                       Mcp-Session-Id -> {agentSessionId, caps}
identity/                         bearer token <-> agentSessionId (DB-backed leaf)
human-channel/                    notify/show/approval sink (panel consumes its events)
deep-link/                        /projects/:id, /tasks/:id, /sessions/:id (+ panel/diff)
tool-registry/                    ToolDefinition contract, registry (caps+guards+envelope), cursors
server-instructions.ts            the elevenex object-model primer (sent once)
tools/{observe,setup,folders,drive,ask}/  tool primitives, grouped + barrelled
__tests__/                        per-group unit specs (mock the service bag)
```

## The tool contract (`tool-registry/tool.types.ts`)

Each tool is a `defineTool({ name, description, costClass, inputShape, handler, … })`. The handler
returns a terse envelope `{ data, touched?, deepLink?, nextStep? }`; actionable failures throw
`ToolError { code, message, remediation?, retryable?, details? }`. The registry enforces the cross-cutting
guarantees so individual tools can't regress them:

- **Capability gating** from the `requiresAgent` / `mutates` / `destructive` flags.
- **Pagination caps** (`paginated` → a `limit` field is clamped) and **empty/pathological-query
  rejection** (`requiresQuery` → blocks `''`, `.`, `*`).
- **Token economy**: results are compact handles (id, status, deepLink), deltas (`read_session`
  cursors), and counts — never full DB objects; hard caps emit `truncated` + a narrow-scope hint.
- **Cost classes** (`instant`/`cached`/`scoped`/`heavy`) distinguish DB reads, cached
  observations, checkout/process work, and expensive setup/agent work. Task preparation and
  prompt/command submission return handles; polling tools and finish cleanup explicitly wait.

## Tasks and tools

- **Session configuration**: `get_session_config` pages model IDs and reports the selected/default model, reasoning levels, provider capabilities, and provider-advertised permission modes. Use it before `set_model` or `set_permission_mode`; `session_status` remains a cheap liveness read.
- **Task lifecycle**: `get_task_defaults`, `create_task`, `list_tasks`, `get_task`,
  `await_task_ready`, `open_task_session`, `rename_task`, `move_task`, `retry_task`, `preview_finish_task`, `finish_task`,
  `reopen_task`, `read_task_draft`, `set_task_draft`.
- **Creation**: `create_task` uses `TasksService` for branch/path reservations, remote refresh,
  clean checkout reuse, snapshot review, external checkout consent and quota recovery. taskId
  is the existing workspaceId. It remains stable after finish/reopen while its checkout can change.
  `open_task_session` reuses a conversation; `create_session` adds another conversation to a ready
  task, derives repo/checkout from it, and uses the configured provider default. Same-task sessions
  and `fork_session` share files. A separate task is needed for isolated parallel work.
- **Recovery and history**: conflict details such as `existingTaskId`, `canSnapshot`, external
  paths, and running-work counts are preserved. `await_task_ready` joins accepted preparation with a
  bounded cancellable wait; cancelling the wait does not cancel setup. `get_task` reports preparation stage and bounded
  conversation pages; `list_tasks` provides a cursor in the actual sidebar order. Finished
  conversations remain discoverable through `find_sessions` with explicit lifecycle filters.
- **Retired agent tools**: the MCP server no longer advertises `create_worktree`,
  `get_worktree_job`, `link_worktree`, `steal_worktree`, `switch_branch`, `rename_worktree`, or
  `delete_worktree`. These legacy primitives bypass task allocation/history; their API/UI
  implementations remain for compatibility. Use the task lifecycle instead. `assess_worktree_pool`
  is available for explicit `environment:existing` selection, with task ownership IDs.
- **Observe**: current/focused session identity, bounded `project_overview`, `find_sessions`,
  `find_branches` (cached local refs, no fetch), session status/waits/transcript deltas/windows,
  file/search/diff/context reads, and `list_todos`, `list_scratchpad`, `read_scratchpad`.
- **Setup**: project/repository setup, task-aware conversation creation, context generation,
  `set_todo`, `set_scratchpad`. Todos are project checklists, distinct from Tasks.
- **Folders**: `list_session_folders`, `create_session_folder`, `rename_session_folder`,
  `move_session_to_folder`, `archive_session_folder`, `unarchive_session_folder`,
  `delete_session_folder`.
- **Drive**: `prompt_session`, `interrupt_session`, `fork_session`, `archive_session`,
  `reset_session`, `rename_session`, `unarchive_session`, `get_pending_action`, `resolve_action`, `set_provider`, `set_model`,
  `set_permission_mode`.
  `prompt_session` accepts optional `mentionSessionIds` (up to 10; deduplicated), attaching the same
  compact snapshots and transcript exports as chat mentions without returning transcript bodies to
  the caller. Source sessions can belong to other tasks or be archived; missions and the target
  itself cannot be mentioned. Create a fresh conversation when prior outcomes suffice; continue a
  warm session when detailed working context matters. Snapshots omit intermediate steps and nested
  snapshots but retain user requests and final responses, so select sources sparingly. For very long
  histories, pass distilled `ask_session` findings instead. `fork_session` preserves history.
- **Ask**: `ask_session` (hidden `agent_query` fork → just the answer, or a `{running, forkId}`
  handle).
- **Human channel** (all `requiresAgent`): `notify_user`, `show_user` (non-blocking FYIs),
  `request_approval`, `escalate_to_user` (BLOCK on the human via the panel). Backed by
  `AgentHumanChannelService`; `AgentChannelGateway` (`/agent-channel` WS) streams these to the panel
  and accepts the human's decision to unblock the waiting tool call.

## Testing

Per-group unit specs under `__tests__/` mock the service bag and call tool handlers directly. Run
`pnpm --dir apps/backend exec jest --runInBand mcp`. (DB-integration specs elsewhere require a `better-sqlite3`
native build matching the test runner's Node ABI.)

## Bounded discovery and transcript reads

Session discovery, project previews, checklist and note listings, and folder membership previews are paged in SQL. Listings select handles and counts instead of bearer tokens, provider state, or note bodies. Note content uses SQLite character windows. Session activity, task membership, folder membership, and MCP token lookups have tracked database indexes.

`read_session` defaults to 20 turns and 12,000 Markdown characters per response, with ceilings of 50 turns and 24,000 characters. Repeat with the same rendering options and `refresh` omitted/false until `truncated` clears. Large turns continue at character boundaries without advancing past undelivered text. Stateful connections retain their own cursor; stateless clients pass the returned opaque `data.cursor`. Rendering flags, provider identity, rewinds, and updated final responses are accounted for. `refresh:true` explicitly restarts history. Anonymous clients without a connection ID do not share cursors.

`fork_session` uses the existing provider history-fork workflow. Supply `anchorMessageId` and `anchorMessageKind` from `read_session(includeIds:true)`. Assistant anchors preserve history through that response; user anchors return an unsent prompt draft. The child shares its task checkout and remains stopped. A failed provider fork cleans up the child. Codex forks receive the child’s MCP token during thread creation, since resuming an already-loaded thread may ignore configuration overrides.

Repository/project removal is destructive and authenticated. Finish active tasks before deleting their container so preparation jobs and checkout processes are not orphaned. This condition is rechecked atomically at deletion. Session cleanup is awaited with bounded concurrency, including archived/hidden sessions; failures retain database records. Container operations cannot stop/delete their own calling session.

The task definitions are split into discovery, lifecycle, composer, and shared-schema modules. Chat rendering uses domain adapters for command outcomes, search matches, diff summaries, and completion transcripts; a command timestamp never implies a finished task.

Tool discovery currently advertises all 75 primitives for compatibility across Claude, Codex, Pi, OpenCode, and external MCP clients. The SDK tool listing is approximately 85 KB of JSON; this is a catalog size measurement, not a model token count. Shared scope guidance is kept concise. Client-side deferred discovery can reduce model context cost without changing the server’s callable tool surface.
