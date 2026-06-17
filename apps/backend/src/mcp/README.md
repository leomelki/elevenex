# Elevenex MCP Server

In-process [Model Context Protocol](https://modelcontextprotocol.io) server that exposes
elevenex's own domain services as MCP tools, so a meta-agent ("do JIRA-123") can **observe and
operate elevenex** — set up projects/repos/worktrees, drive inner coding sessions, and escalate to
the human. It is the integration surface described in `ELEVENEX_AGENT.md` / `ELEVENEX_AGENT_PLAN.md`.

## How it's wired

- **Transport**: `@modelcontextprotocol/sdk` `McpServer` + `StreamableHTTPServerTransport`, mounted
  as a raw Express route at `POST/GET/DELETE /api/mcp` in the **pre-body-parser** block of
  `main.ts` (next to the mcp-auth-proxy) so the transport reads the raw request stream. One
  `McpServer`+transport per `Mcp-Session-Id`; `GET` is the SSE notify channel, `DELETE` tears down.
- **Identity**: an agent session is minted an `mcpAgentToken` (column on `sessions`), injected into
  the inner process as `ELEVENEX_AGENT_TOKEN` (`claude-runtime.service.ts`). The shared
  `~/.elevenex/agent/.mcp.json` (written by `ElevenexAgentService`) carries
  `Authorization: Bearer ${ELEVENEX_AGENT_TOKEN}`. The server resolves the bearer → agent session id
  → routes human-channel tools to that session's panel. Tokenless callers are anonymous external
  clients: reads + non-destructive mutations only; destructive ops and the human channel are denied.
- **Services reused in-process** (no loopback HTTP): see `tool-registry/mcp-tool-services.ts`.
- **Downstream-only** module: it consumes domain modules and nothing consumes it (no new cycles).

## Layout

```
elevenex-mcp.module.ts            wiring (imports domain modules, provides the server)
transport/                        Mcp-Session-Id map + SSE/DELETE; McpServer factory
connection/                       Mcp-Session-Id -> {agentSessionId, caps}
identity/                         bearer token <-> agentSessionId (DB-backed leaf)
human-channel/                    notify/show/approval sink (panel consumes its events)
deep-link/                        /projects/:id, /sessions/:id (+ panel/diff)
tool-registry/                    ToolDefinition contract, registry (caps+guards+envelope), cursors
server-instructions.ts            the elevenex object-model primer (sent once)
tools/{observe,setup,drive,ask}/  the 32 tool primitives, grouped + barrelled
__tests__/                        per-group unit specs (mock the service bag)
```

## The tool contract (`tool-registry/tool.types.ts`)

Each tool is a `defineTool({ name, description, costClass, inputShape, handler, … })`. The handler
returns a terse envelope `{ data, touched?, deepLink?, nextStep? }`; actionable failures throw
`ToolError { code, message, remediation?, retryable? }`. The registry enforces the cross-cutting
guarantees so individual tools can't regress them:

- **Capability gating** from the `requiresAgent` / `mutates` / `destructive` flags.
- **Pagination caps** (`paginated` → a `limit` field is clamped) and **empty/pathological-query
  rejection** (`requiresQuery` → blocks `''`, `.`, `*`).
- **Token economy**: results are compact handles (id, status, deepLink), deltas (`read_session`
  cursors), and counts — never full DB objects; hard caps emit `truncated` + a narrow-scope hint.
- **Cost classes** (`instant`/`cached`/`scoped`/`heavy`): heavy tools (`create_worktree`,
  `prompt_session`, `ask_session`, `generate_worktree_context`, `await_session_event`) return a
  handle/state immediately and never block.

## Tools (37)

- **Observe**: `project_overview`, `find_sessions`, `session_status`, `read_session`, `text_search`,
  `file_search`, `read_file`, `change_review`, `get_worktree_context`, `await_session_event`.
- **Setup**: `find_or_create_project`, `add_repo`, `remove_repo`, `assess_worktree_pool`,
  `create_worktree`, `get_worktree_job`, `link_worktree`, `steal_worktree`, `create_session`
  (bridges worktree → session, ready for `prompt_session`), `generate_worktree_context`, `set_todo`,
  `set_scratchpad`.
- **Drive**: `prompt_session`, `interrupt_session`, `fork_session`, `archive_session`,
  `reset_session`, `get_pending_action`, `resolve_action`, `set_provider`, `set_model`,
  `set_permission_mode`.
- **Ask**: `ask_session` (hidden `agent_query` fork → just the answer, or a `{running, forkId}`
  handle).
- **Human channel** (all `requiresAgent`): `notify_user`, `show_user` (non-blocking FYIs),
  `request_approval`, `escalate_to_user` (BLOCK on the human via the panel). Backed by
  `AgentHumanChannelService`; `AgentChannelGateway` (`/agent-channel` WS) streams these to the panel
  and accepts the human's decision to unblock the waiting tool call.

## Testing

Per-group unit specs under `__tests__/` mock the service bag and call tool handlers directly. Run
`pnpm --filter backend jest src/mcp`. (DB-integration specs elsewhere require a `better-sqlite3`
native build matching the test runner's Node ABI.)
