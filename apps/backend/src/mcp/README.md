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
  Sessions expire after 15 idle minutes; `ELEVENEX_MCP_IDLE_TIMEOUT_MS` accepts integer
  milliseconds from 1000 to 86400000. An active tool suspends expiry and starts a fresh idle
  period when it finishes. SSE disconnects preserve the logical session. Initialization failure,
  expiry, DELETE and module shutdown close transports/servers and clear registrations/cursors.
- **Harness endpoint**: legacy TCP backends use their configured edge-proxy port.
  Socket-only desktop backends (`ELEVENEX_DESKTOP_SOCKET`) start a separate MCP-only
  HTTP listener on an OS-assigned `127.0.0.1` port. Bootstrap awaits this before
  `app.init()` so mission startup and workspace configuration see the actual address.
  `McpAgentEndpointService` owns the listener and publishes its address as application
  process configuration in `ELEVENEX_MCP_URL`; the shared `elevenexMcpUrl()` resolver
  supplies Claude, Codex (including forks), OpenCode, Pi, and mission workspace config.
  An explicit nonblank `ELEVENEX_MCP_URL` takes precedence in either transport mode.
  Socket mode fails explicitly if a runtime requests the URL before endpoint startup.
  The extra listener accepts only `/api/mcp`, validates Host/Origin, and requires a
  live session bearer on **every** request, including initialization and discovery.
  It never exposes backend API, WebSocket, or terminal routes. Anonymous external-client
  compatibility remains on the existing edge transport. Shutdown closes active SSE
  connections and releases the assigned port. Multiple backend instances do not share
  ports. Existing provider processes retain their loaded tools/configuration; after
  deploying backend changes, reconnect idle runtimes to adopt the new endpoint.
- **Identity**: every coding session and mission lazily receives a stable `mcpAgentToken`.
  Claude, Codex, and OpenCode receive the authenticated HTTP server through runtime configuration;
  Pi receives `ELEVENEX_AGENT_TOKEN` and `ELEVENEX_MCP_URL` through its extension environment.
  Credentials are never written to the coding repository or included in the model prompt.
  Tokens resolve to the calling session, independently of UI focus, and cached identities are
  checked against the database so deleted sessions lose access. Tokenless callers retain reads
  and non-destructive mutations; destructive operations and human-channel tools require identity.
- **Coding session context**: `get_current_session` returns live session/project/repo/workspace
  ids (including taskId/worktreeId), names, task lifecycle, branch, checkout, provider, and plan mode without a transcript or git scan.
  Use it only when an operation needs unknown Elevenex IDs or the current task/checkout assignment
  is uncertain. Coding agents work directly with their supplied directory and current-session
  defaults; this lookup is not a startup or per-turn prerequisite.
  Coding sessions retain their native tools and coding prompts. Missions keep their orchestration
  mandate and autonomy policy. Existing sessions receive the connection when their runtime next
  starts or resumes a turn.
- **Default scopes**: tools opting into `currentSessionScope` allow coding callers to omit
  scope: transcript/status tools use their session; file/diff/context/actions use its worktree;
  notes/todos use its project; task reads, labels, and drafts use its task; repository discovery and task creation use its repo. Explicit scopes take precedence.
  Missions and external clients must still scope calls explicitly. Session-control tools keep
  required targets; `disallowSelfTarget` rejects self prompts/stops and deleting or archiving containers that include the caller. `finish_task` checks self-targets in its handler: `userRequested:true` attests that the user explicitly asked to finish, using the same agent-attested consent convention as `confirmStop`. Completing coding work is not consent. Self-finishing persists a request and returns `finishScheduled:true`; cleanup waits for caller/background idle after the final reply, and rechecks membership/activity under the repository lock. Restart recovery resumes pending requests. The requesting conversation can use `cancel_finish_task` without extra human approval before cleanup starts; cancellation atomically clears the saved request even while the worker waits for a repository lock or process preview. Once cleanup claims state `finishing`, cancellation cannot undo it. Generation IDs prevent cancelled workers from acting on later schedules. Shared task-finish instructions explain the full effects and cancellation window to coding sessions and missions. `confirmStop` remains a separate approval for stopping other running work. File/command scope validates the session’s task checkout before using it, protecting historical paths after reuse.
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
session-event-subscriptions.ts    keyed lifecycle subscriptions and shared state reads
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
  `grep_session` preserves JavaScript per-line regex semantics in a disposable worker (two
  concurrent searches, 5-second render/search deadline, immediate abort). Rendering uses
  bounded chunks with backpressure: each rendered preamble/turn input projection is limited
  to 2 Mi characters and 50000 values, and rendered text to 32 Mi characters; larger input fails
  explicitly with `grep_input_limit`. Fields omitted by precision or render options do not
  consume the input budget. The existing history/model loader still reads the full session
  before the deadline starts. Returned lines cap at 2000 characters, and combined match/context text
  at 24000 characters. `truncation` distinguishes match, line and aggregate limits. Human
  approvals/selections are removed from panels and rejected on tool abort or module shutdown.
- **Cost classes** (`instant`/`cached`/`scoped`/`heavy`) distinguish DB reads, cached
  observations, checkout/process work, and expensive setup/agent work. Task preparation and
  prompt/command submission return handles; polling tools and finish cleanup explicitly wait.

## Tasks and tools

- **Desktop port forwarding**: `list_port_forwards`, `get_port_forward`, `create_port_forward`,
  `start_port_forward`, `stop_port_forward`, `remove_port_forward`. Authenticated callers default
  to their project. These tools use the `/desktop-port-forwarding` WebSocket bridge, because the
  user’s local listeners, SSH configuration, pairing credentials and saved definitions live on
  the desktop even when the backend/agent runs remotely. The Angular root starts the bridge
  independently of the visible task. Browser-only clients do not register a forwarding bridge.
  Each request targets one registered desktop window. Windows on one desktop share a persistent
  desktop ID; distinct desktops require explicit selection. Requests time out after 45 seconds,
  reject on disconnect, and are never replayed onto another window. Cancellation stops queued
  mutations; accepted runtime work may complete, so inspect state before retrying.
  Creation reuses matching project/connection/bind/destination definitions; UI and agent mutations
  share per-environment Web Locks. Lists query live runtime state only for the requested page.
  Agent creation binds to loopback and does not accept credentials. Saved private keys or desktop
  SSH config/agent authenticate SSH; password/passphrase entry remains a desktop concern.
  Results omit debug command/config data, include `running`, `status`, `lastError`, and a desktop-local
  HTTP convenience URL. An active listener does not prove target service readiness. Forwards persist
  until stopped/removed, following existing project UI behavior rather than task lifetime.
  Creation records the authenticated agent conversation in the desktop definition. The Ports
  view links back to its creator and refreshes after local mutations or shared storage changes.
  Chat receipts show destination, listener state, reuse, errors and direct Ports navigation;
  collapsed activity retains an issue badge, while recorded state is kept distinct from live state.

- **Session configuration**: `get_session_config` pages model IDs and reports the selected/default model, reasoning levels, provider capabilities, and provider-advertised permission modes. Use it before `set_model` or `set_permission_mode`; `session_status` remains a cheap liveness read.
- **Task lifecycle**: `get_task_defaults`, `create_task`, `list_tasks`, `get_task`,
  `await_task_ready`, `open_task_session`, `rename_task`, `move_task`, `retry_task`, `preview_finish_task`, `finish_task`, `cancel_finish_task`,
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
- **Drive**: `prompt_session`, `interrupt_session`, `stop_background_task`, `fork_session`, `archive_session`,
  `cancel_session_delegation`, `reset_session`, `rename_session`, `unarchive_session`, `get_pending_action`, `resolve_action`, `set_provider`, `set_model`,
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

An authenticated session can pass `temporary:true` to `create_task` for
disposable work it initiates. The creating session can finish that task with
`finish_task` after it collects the result. The engine requires a clean managed
checkout, an idle task, and no Git operation in progress. **Keep open** revokes
that permission. Explicit user-requested closes follow the normal rules. Closing
preserves the branch and transcripts. Reopened tasks require user consent to
close again.

## Cross-harness delegation

Coding sessions use native subagents for work in their own harness when available.
Use `list_agent_harnesses` for the other harness IDs and native subagent support.
Passing `provider` pages that harness’s models and reasoning efforts before a
conversation exists. Explicit model and effort selections are saved with the
session before the first turn runs. Known capability mismatches fail before
creation. Project-local and newly available models may be accepted by the
harness before they appear in the discovery catalog.

```json
{
  "provider": "codex",
  "name": "Review concurrent sends",
  "prompt": "Review the prompt queue for lost sends. Report findings with file references. Leave the shared files untouched.",
  "requestId": "review-concurrent-sends",
  "role": "review",
  "mode": "async"
}
```

Pass these arguments to `create_session`. It defaults to the authenticated
coding session’s task and places the child in the parent’s sidebar group.
Delegation from a nested session adds a sibling in the same two-level group and
records the actual delegator. `get_current_session` identifies both the sidebar
parent and the delegator. Sidebar moves preserve the delegator identity.
`placement:"task"` or an explicit folder places a session at task level.
Mission and external calls supply a task ID and create at task level.

Give each child a self-contained brief and clear file ownership. Sessions in
a task share its checkout. Separate tasks provide checkout isolation. Coding
sessions in plan mode can compose a brief and begin delegation after approval
to leave plan mode. Each child uses its harness’s own runtime permission policy.

The first prompt requires a `requestId`. If the response is lost, reuse the
same request ID and inputs. The session row and receipt are committed together,
and the backend claims the first delivery once. A pending receipt means the
harness may still accept the original instruction. After an interruption or
backend restart, use the existing handle to reconcile the transcript before
sending more work. A blank `create_session` still supports a later `prompt_session`.

Start independent work before waiting. `await_session_event` accepts one
`sessionId` or up to 16 `sessionIds`. It returns the first completion, pending
decision, failure or paused queue. Work still held by a harness’s background
jobs or prompt queue keeps the session active. With `includeReply:true`, a
completion includes the latest final reply when available, capped at 8,000
characters, with its transcript item ID. Remove handled IDs before waiting
again. Use `read_session` or `read_session_range` for detailed evidence.

Use `mode:"async"` on a same-task delegate when work may outlast the parent
turn. When the child asks for a blocking decision or finishes, Elevenex can
resume an idle parent with the child session ID, outcome, and a short result
excerpt when available. Ready siblings can share one notice. A parent already
waiting on the child receives the event through the wait. The notice asks the
parent to inspect pending decisions through `get_pending_action` and involve
the user when authorization is required.

Use `mode:"wait"` to launch and wait for one child in the same call. The wait
lasts up to 45 seconds. When it times out, the child continues and retains its
parent wakeup. `completion:"notify"` remains an alias for asynchronous notice
delivery. Omitting both fields preserves explicit collection with
`await_session_event`. An optional `role` adds a responsibility to the initial
brief. For an independent re-check, launch a fresh delegate with the current
brief, prior findings, and changes.

The backend recovers outstanding notices from its database. If the harness
may have accepted a notice before a crash, Elevenex leaves it unconfirmed
and avoids starting a second turn. The delegating session can see
`completionNotice` in `session_status` and inspect the child directly.
Plan mode and pending task finish requests prevent automatic continuation.
An explicit stop of the parent clears its outstanding notices.

Use `prompt_session` for a focused follow-up. Authenticated sends carry the
sender’s session ID. The tool starts an idle session and prefers live input
for an active turn on Codex, Claude, Pi, and OpenCode v1 or v2 when the harness
can accept it. Claude schedules priority input for its next native boundary,
and Pi delivers steering before its next model call.
Busy harnesses without live steering queue the follow-up. An existing queue
takes precedence over automatic steering. `mode:"queue"` or `queue:true` requests
a separate turn. `mode:"steer"` requires a live turn that can accept steering.
`mode:"restart"` explicitly interrupts active work before submitting and requires
an empty prompt queue. The send reports `running`, `steered`
or `queued` as its acceptance disposition. If acceptance is pending or
transport failed during delivery, inspect the session before resending.
Session messages and results provide
agent context and evidence. User decisions still go through the existing
approval tools. A child can return findings, changed files, checks and blockers
in its final reply for its parent to collect.

Use `cancel_session_delegation` for a direct delegate you no longer need. It
interrupts active work and clears queued prompts in the delegate and its
Elevenex descendants while retaining their conversations. For a single
interruption with the queue preserved, use `interrupt_session`.

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

Tool discovery advertises the full catalog for compatibility across Claude, Codex, Pi, OpenCode, and external MCP clients. Shared scope guidance is kept concise; larger browser API guidance is returned only when requested. Client-side deferred discovery can reduce model context cost without changing the server’s callable tool surface.

## Browser code

`browser_run` and `browser_reset` replace `task_browser`. Call `browser_run`
without code for the versioned API and host choices; execute batched JavaScript
against the authenticated conversation's task. The [browser design](../../../../docs/browser-agent.md)
documents worker isolation, ownership, inline images, bounded diagnostics and
timeout recovery. Other MCP consumers and legacy desktop mailbox commands keep
their existing contracts.
