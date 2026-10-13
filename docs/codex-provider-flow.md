# OpenAI Codex Provider Flow

Elevenex exposes Codex through the existing agent runtime provider registry.
Claude Code remains the default provider and keeps its own session id,
permissions, MCP handling, terminal fallback, and transcript behavior.

## Runtime Flow

1. The frontend connects to `/agent-runtime?sessionId=<id>&provider=codex`.
2. `AgentRuntimeGateway` resolves the `codex` provider from
   `AgentRuntimeRegistryService`.
3. `CodexAgentRuntimeProvider` delegates execution to `CodexRuntimeService`.
4. `CodexRuntimeService` starts or resumes a Codex app-server thread with:
   - `cwd` set to the session worktree.
   - the selected Codex model.
   - Codex sandbox and approval settings derived from the app permission mode.
5. The Codex model picker fetches the account's current catalog from Codex
   app-server's `model/list` RPC, caches it, and refreshes it periodically.
   Elevenex only uses its built-in catalog as a fallback when that RPC is
   unavailable, so prompt submission still works.
6. Image attachments are staged as temporary local image files and sent through
   Codex app-server `localImage` inputs.
7. Codex app-server stream events are converted into the same transcript item shape
   rendered by the existing workspace UI.
8. The Codex thread id is stored in `sessions.codex_session_id`; Claude's
   `sessions.claude_session_id` is not reused or modified.

## Conversation Editing And Forking

Both operations create a native Codex fork at a turn boundary and verify that
the retained history is persisted before publishing it. Editing replaces the
session's thread id only after that verification, leaving the original intact
if the fork fails. Legacy CLI versions that ignore fork boundaries are trimmed
with `thread/rollback`; current versions trim the fork natively.

Paginated threads can return an empty `thread/read` turn list. Elevenex derives
their boundaries and visible user-message counts from the saved rollout events.
Paginated forks store a `history_base` reference instead of copying the parent
rollout. History reads resolve the frozen byte/ordinal prefix recursively,
including nested forks, and keep the child's identity and message anchors stable.
Later parent turns remain outside that prefix, and inherited bytes count toward
the transcript cache limit. Missing or invalid parent history fails explicitly.

## Subagents

Collaboration tools use dedicated action cards rather than generic JSON output.
Spawn, message/input, follow-up, wait/list, interrupt, resume, and close operations
show readable receipts, agent identities, and available model/context metadata.
Known owned agents link directly to the inspector. Assignment/message text and
reported responses support Markdown, local-file navigation, and copying. Wait
timeouts, failures, missing receipts, and unavailable sealed text remain explicit.
Agent-list statuses describe the recorded check; newer differing statuses are
marked separately. The original tool data stays available in a collapsed section.

User input is governed by the parent thread's active turn, not the number of
running children. An active parent accepts queued follow-ups; the queued message's
Steer action uses native `turn/steer` without interrupting work. An idle parent accepts a new turn
immediately while its subagents continue. The composer and status tooltip therefore
show background activity without claiming that all child work must finish first.
This lets users ask the parent to redirect, stop, or coordinate its agents.

Codex supports the shared agents inspector, both during a turn and after reopening
the conversation. The composer shows a compact overview with active agents first.
The inspector groups nested agents under their parent, supports assignment/name
search and active/attention filters, and distinguishes startup, running, waiting,
completion, interruption, failure, shutdown, and unavailable states. Only the
selected active transcript refreshes, every two seconds; closing the inspector
stops that polling. Refresh failures retain the last transcript and offer retry.

The inspector defaults to the same shared chat renderer as the main conversation:
messages, thinking, tools, copy actions, and completed-turn summaries. Activity and
hooks remain secondary views. Context appears only as the normal compact status-row
button for the selected child, with token details and report time in its popover.
Live `thread/tokenUsage/updated` notifications and saved `token_count` records
use the latest response's tokens and reported model window, never cumulative
billing totals or a guessed capacity. Inherited parent usage is excluded. Usage
has its own timestamp so transcript polling cannot overwrite a newer live count.
Usage can decrease after compaction. The compact button is omitted when the
provider has not reported usable counts and capacity, matching normal chat.

The runtime tracks native `collabAgentToolCall`, `subAgentActivity`, spawned-thread
metadata, and child thread lifecycle notifications. Child output stays separate
from the parent transcript. Saved spawn/wait/follow-up receipts restore the graph;
CLI versions returning `task_name` paths are mapped to child thread IDs through
the rollout's `session_meta.source.subagent.thread_spawn.agent_path`. Metadata
indexing reads only bounded first records, limits concurrent IO, and coalesces
requests. Transcript reads use the existing revision-aware cache. Inherited
conversation content is trimmed at the child's assignment or creation boundary.
Sealed message bodies and assignments are shown as unavailable details, while
readable transcript events and communication receipts remain inspectable.

The history endpoint accepts only agents belonging to the requested session.
Missing rollouts return an explicit unavailable state with the assignment still
visible. Background children keep the app-server alive after the parent replies,
and their approval/input requests use the normal composer dock. Session cleanup
interrupts and verifies active child turns before releasing the environment.

## Permission Mapping And Requests

Elevenex maps the UI permission style into Codex app-server sandbox settings
when Plan Mode is off:

| UI mode             | Codex sandbox        | Codex approval policy      |
| ------------------- | -------------------- | -------------------------- |
| `default`           | `workspace-write`    | `on-request`               |
| `auto`              | `workspace-write`    | `on-request` + auto-review |
| `acceptEdits`       | `workspace-write`    | `never`                    |
| `bypassPermissions` | `danger-full-access` | `never`                    |

Plan Mode is tracked separately from the permission style. Every turn selects
Codex app-server's native collaboration mode explicitly: `plan` while Plan Mode
is on and `default` after it is disabled. Plan turns also use a read-only
sandbox with `approvalPolicy: "never"`. Sending the `default` collaboration
mode on the first implementation turn replaces the earlier planning
instructions while preserving the thread, matching Codex's native mode switch
behavior.

Every `turn/start` also sets `cwd`, `sandboxPolicy`, `approvalPolicy`, and
`approvalsReviewer` explicitly. Resuming an already-loaded thread can ignore
thread configuration overrides, so setting permissions only on `thread/resume`
can leave implementation turns stuck with the plan's read-only sandbox and
`never` approval policy. Turn overrides restore the selected permission style
on the same thread, including its worktree as a writable root, and reapply
read-only permissions when Plan Mode is enabled again. The reviewer is also
reset to `user` outside automatic review mode.

When Codex app-server emits server-to-client JSON-RPC requests for command
execution, file changes, permission-profile grants, `request_user_input`, or
MCP elicitations, Elevenex now bridges them into the existing permission and
user-input UI. User responses are translated back into Codex response payloads
such as `accept`, `acceptForSession`, empty permission grants, structured
question answers, or MCP elicitation actions.

Native `request_user_input_async` questions arrive in completed `agentMessage`
items with `delivery: "async"` and `questions: [{ title, options?: string[] }]`.
Elevenex displays them in the shared question form while Codex keeps running.
Pending questions are queued in session runtime state and survive turn completion
and frontend reconnects. Answers use `turn/steer` while a turn is active, or a
new user turn after it completes. Dismissing a native async question removes it
without sending a follow-up. Runtime state is held in memory, so pending forms
do not survive a backend restart.

RPC `item/tool/requestUserInput` also honors `isBlocking: false`; omitted values
keep the blocking behavior for older Codex versions. `serverRequest/resolved`
clears RPC questions cancelled by Codex without sending a stale response.

## Event Normalization

Codex SDK items are normalized as follows:

| Codex item              | Elevenex transcript item                |
| ----------------------- | --------------------------------------- |
| `agent_message`         | assistant message                       |
| `plan`                  | assistant message with plan markdown    |
| `reasoning`             | thinking block                          |
| `command_execution`     | `Bash` tool use plus tool result        |
| `file_change`           | `FileChanges` tool use plus tool result |
| `mcp_tool_call`         | MCP tool use plus tool result           |
| `web_search`            | `WebSearch` tool use                    |
| `todo_list`             | `TodoWrite` tool use                    |
| `error` / `turn.failed` | error item/event                        |

`item.started` and `item.updated` are used to keep live tool state visible.
`item.completed` emits final results. `turn.completed` updates context usage
with Codex token counts.

## Abort And Status

Each active Codex run owns an `AbortController`. Interrupting a run aborts the
current streamed turn, clears live items, marks the runtime idle, and emits the
same `complete` event shape used by Claude. Runtime state is available through:

```text
GET /api/sessions/:sessionId/agents/codex/runtime-state
GET /api/sessions/:sessionId/agents/codex/snapshot
```

Global Codex auth status is available at:

```text
GET /api/agent-providers/codex/auth/status
```

The status check reads `codex --version` and `~/.codex/auth.json`, accepting
OAuth tokens or `OPENAI_API_KEY`.

## MCP Config

Codex MCP config is read from:

```text
~/.codex/config.toml
<workspace>/.codex/config.toml
```

Servers are loaded from `[mcp_servers.<name>]`. Elevenex supports user and
project scopes, `stdio` servers with `command`, and HTTP servers with `url`.
MCP management uses the shared configuration layer: add, edit, remove and toggle
operations target a server's exact scope and file. Disabling writes `enabled = false`.
Edits preserve unrelated TOML and detect conflicting external changes.

The manager renders configuration immediately and refreshes live inventory in the
background through `mcpServerStatus/list`. Browser authentication uses
`mcpServer/oauth/login`; Reload tools calls `config/mcpServer/reload`. The shared
manager also supports Claude, OpenCode (v1/v2 JSONC), and Pi's MCP client extension.
Configuration changes remain visibly pending until the session reloads its tools.

## Session History

Codex JSONL history is parsed from:

```text
~/.codex/sessions/**/*.jsonl
```

The parser extracts visible plain user messages, assistant messages, reasoning,
function/custom tool calls, tool outputs, cwd, model, timestamps, and session
metadata. Internal Codex context events are ignored so the transcript stays
user-facing.

## Auxiliary AI Flows

Worktree context analysis and commit message generation use the active session
provider selected in the workspace UI. They do not switch between Claude and
Codex automatically. When Codex is selected, both flows use short-lived
read-only Codex SDK threads with `approvalPolicy: never`, the worktree as
`workingDirectory`, and `gpt-5.5` as the default model.

When Claude is selected, the existing Claude Code SDK implementation is used.
When Codex is selected, the API response includes `source: "codex"` if Codex
produces the accepted Conventional Commit JSON. Unsupported providers are
rejected instead of falling back to Claude, Codex, an external generator, or a
local heuristic implicitly.
