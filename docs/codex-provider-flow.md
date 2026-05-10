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
5. The Codex model picker is seeded with the current Codex catalog
   (`gpt-5.5` by default, plus `gpt-5.4`, `gpt-5.4-mini`,
   `gpt-5.3-codex`, and `gpt-5.2`) and refreshes from Codex app-server's
   `model/list` RPC when the local CLI supports it. If that RPC is unavailable,
   Elevenex keeps the built-in catalog so prompt submission still works.
6. Image attachments are staged as temporary local image files and sent through
   Codex SDK `local_image` inputs.
7. Codex SDK stream events are converted into the same transcript item shape
   rendered by the existing workspace UI.
8. The Codex thread id is stored in `sessions.codex_session_id`; Claude's
   `sessions.claude_session_id` is not reused or modified.

## Permission Mapping

Codex does not currently expose Claude's interactive per-tool approval callback.
Elevenex maps the UI permission mode into Codex SDK sandbox settings instead:

| UI mode | Codex sandbox | Codex approval policy |
| --- | --- | --- |
| `default` / `auto` | `workspace-write` | `untrusted` |
| `acceptEdits` | `workspace-write` | `never` |
| `bypassPermissions` | `danger-full-access` | `never` |

Plan mode and plan-bypass are Claude-specific. When Codex is selected, the UI
offers only `default`, `acceptEdits`, and `bypassPermissions`.

## Event Normalization

Codex SDK items are normalized as follows:

| Codex item | Elevenex transcript item |
| --- | --- |
| `agent_message` | assistant message |
| `reasoning` | thinking block |
| `command_execution` | `Bash` tool use plus tool result |
| `file_change` | `FileChanges` tool use plus tool result |
| `mcp_tool_call` | MCP tool use plus tool result |
| `web_search` | `WebSearch` tool use |
| `todo_list` | `TodoWrite` tool use |
| `error` / `turn.failed` | error item/event |

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
