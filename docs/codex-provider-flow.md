# OpenAI Codex Provider Flow

Elevenex exposes Codex through the existing agent runtime provider registry.
Claude Code remains the default provider and keeps its own session id,
permissions, MCP handling, terminal fallback, and transcript behavior.

## Runtime Flow

1. The frontend connects to `/agent-runtime?sessionId=<id>&provider=codex`.
2. `AgentRuntimeGateway` resolves the `codex` provider from
   `AgentRuntimeRegistryService`.
3. `CodexAgentRuntimeProvider` delegates execution to `CodexRuntimeService`.
4. `CodexRuntimeService` starts or resumes an `@openai/codex-sdk` thread with:
   - `workingDirectory` set to the session worktree.
   - `skipGitRepoCheck: true`.
   - the selected Codex model.
   - Codex sandbox and approval settings derived from the app permission mode.
5. The Codex model picker fetches the account's current catalog from Codex
   app-server's `model/list` RPC, caches it, and refreshes it periodically.
   Elevenex only uses its built-in catalog as a fallback when that RPC is
   unavailable, so prompt submission still works.
6. Image attachments are staged as temporary local image files and sent through
   Codex SDK `local_image` inputs.
7. Codex SDK stream events are converted into the same transcript item shape
   rendered by the existing workspace UI.
8. The Codex thread id is stored in `sessions.codex_session_id`; Claude's
   `sessions.claude_session_id` is not reused or modified.

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
Toggling a server writes a `disabled` flag back to the TOML config. Codex MCP
browser auth is not implemented because Codex handles server auth through its
CLI/config and environment variables rather than Claude's elicitation flow.

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
