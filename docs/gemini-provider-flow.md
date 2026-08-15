# Gemini CLI Provider Flow

Elevenex exposes Google's Gemini CLI through the existing agent runtime provider
registry, driven headlessly over the **Agent Client Protocol (ACP)**. Claude Code
remains the default provider and keeps its own session id, permissions, MCP
handling, terminal fallback, and transcript behavior.

Everything below was verified against **gemini-cli 0.55.1 / ACP protocolVersion 1**.

## Runtime Flow

1. The frontend connects to `/agent-runtime?sessionId=<id>&provider=gemini`.
2. `AgentRuntimeGateway` resolves the `gemini` provider from
   `AgentRuntimeRegistryService`.
3. `GeminiAgentRuntimeProvider` delegates execution to `GeminiRuntimeService`.
4. `GeminiRuntimeService` starts a `GeminiSessionRuntime`, which spawns
   `gemini --acp --skip-trust` in the session worktree and completes the ACP
   handshake.
5. The runtime resumes `session/load` when a session id is stored and the agent
   advertises `loadSession`, otherwise it creates one with `session/new`.
6. Image attachments are sent as ACP `image` content blocks (the agent reports
   `promptCapabilities.image: true`).
7. `session/update` notifications are converted into the same transcript item
   shape rendered by the existing workspace UI.
8. The ACP session id is stored in `sessions.gemini_session_id`; the other
   providers' id columns are not reused or modified.

One `gemini` process runs per Elevenex session rather than one shared server:
ACP fixes `cwd` at `session/new`, and sessions live in different worktrees.
Processes are reference-counted against attached clients, shut down after
`GEMINI_RUNTIME_IDLE_MS` (default 5 min) idle, and capped at
`GEMINI_RUNTIME_IDLE_CAP` (default 20) idle instances.

### Why `--skip-trust`

Gemini refuses to load project-level agents, hooks, and extensions in a folder
it does not consider trusted, and in ACP mode there is no TUI to answer the
trust prompt — it logs `Skipping project agents due to untrusted folder` and
runs degraded. Non-interactive mode fails outright with exit code 126. Elevenex
only ever points Gemini at a worktree the user explicitly opened, so the trust
decision has already been made one level up. (`GEMINI_CLI_TRUST_WORKSPACE=true`
is the documented environment-variable equivalent.)

## ACP Method Map

Client → agent:

| Method | Use |
| --- | --- |
| `initialize` | Handshake; advertises `fs` capability, declines `terminal` |
| `authenticate` | Drives OAuth via the CLI's own browser flow |
| `session/new` | Creates a session; returns `modes` and `models` |
| `session/load` | Resumes a stored session, replaying it as `session/update`s |
| `session/prompt` | Submits a turn; resolves with a `stopReason` |
| `session/cancel` | Notification backing interrupt |
| `session/set_mode` | Permission style + plan mode |
| `session/set_model` | Model picker |

Agent → client:

| Method | Handling |
| --- | --- |
| `session/update` | Transcript firehose (see below) |
| `session/request_permission` | Bridged into the existing permission UI |
| `fs/read_text_file` | Served from the worktree, path-containment enforced |
| `fs/write_text_file` | Served from the worktree, path-containment enforced |
| anything else | Rejected with `-32601` |

The client capability `terminal` is deliberately **false**. Gemini then runs
shell commands with its own execute tool and reports output through `tool_call`
content, which is what the workspace already renders; advertising a client
terminal would add a second command-execution path for no gain.

ACP is strict JSON-RPC 2.0 — unlike the Codex app-server, every frame carries
`"jsonrpc": "2.0"`.

## Event Normalization

| ACP `sessionUpdate` | Elevenex transcript item |
| --- | --- |
| `agent_message_chunk` | assistant message (streamed append) |
| `agent_thought_chunk` | thinking block |
| `user_message_chunk` | user message (only during `session/load` replay) |
| `tool_call` | tool use, live state |
| `tool_call_update` | tool use update, plus a tool result once completed/failed |
| `plan` | assistant message with `contentType: 'plan'` |
| `available_commands_update` | feeds `getAutocompleteItems()` |
| `current_mode_update` | permission-mode / plan-mode echo |

Two filters matter:

- **`[MODE_UPDATE] <mode>`** — `session/set_mode` makes gemini echo a synthetic
  assistant chunk with this prefix. It is protocol bookkeeping, not model
  output, and is dropped before it reaches the transcript.
- **`<session_context>…</session_context>`** — Gemini injects OS, date,
  workspace directories, and a 200-entry directory tree as the first user
  message. It is stripped so the user's actual first prompt is what shows.

ACP `tool_call` carries a human `title` and a coarse `kind`, not the tool id.
`canonicalizeGeminiTool` tries the tool's own name through the shared
`canonicalizeAgentTool` normalizer first (which knows Gemini's `read_file`,
`write_file`, `replace`, `run_shell_command`, `search_file_content`,
`list_directory`, `google_web_search`, `read_many_files`, `write_todos` names)
and only falls back to the ACP `kind` when that yields `unknown`.

## Permission Mapping

Gemini reports its modes at `session/new`; Elevenex maps the UI permission style
onto them and only sends a mode the running agent actually advertised.

| UI mode | ACP mode id |
| --- | --- |
| `default` | `default` |
| `acceptEdits` / `auto` | `autoEdit` |
| `bypassPermissions` / `dontAsk` | `yolo` |
| Plan Mode on (any style) | `plan` |

Plan Mode is tracked separately from the permission style and outranks it, the
same way Codex layers plan mode over its sandbox settings. Gemini has a **native
read-only `plan` mode**, so no prompt-level workaround is needed.

`session/request_permission` supplies its own option ids, so a user decision is
matched to an option by `kind` (`allow_once`, `allow_always`, `reject_once`,
`reject_always`) rather than by assuming ids. Interrupting a turn answers every
outstanding permission request with `cancelled` first — gemini will not act on
`session/cancel` while it is blocked waiting for one.

## Models

`session/new` returns the account's real model list, which replaces a small
built-in fallback catalog (`auto`, `gemini-3.1-pro-preview-customtools`,
`gemini-3.5-flash`, `gemini-3-flash-preview`, `gemini-3.1-flash-lite`,
`gemini-2.5-pro`). The fallback exists so the settings picker is never empty
when the user is signed out. `auto` is the provider default.

`getModelCatalog()` reports `reasoningEfforts: []`: Gemini exposes a thinking
budget rather than the shared low/medium/high ladder, and ACP has no way to set
it. The registry substitutes the generic list so the picker still renders, and
the per-session thinking-level selection is recorded but not sent to the agent.

## Auth

Credential *storage* is deliberately not modelled — gemini-cli has moved its
on-disk layout between releases (0.55 keeps config under `~/.gemini/config/`)
and supports four auth methods. Instead, `GeminiAuthService` asks the CLI:

- `gemini --version` for installed/version (cached 1 h).
- An ACP `initialize` + `session/new` probe for "would a prompt work?" (cached
  60 s, concurrent callers coalesced). This is the one signal that is correct
  for OAuth, API key, Vertex, and gateway alike.

Auth methods reported by `initialize`: `oauth-personal`, `gemini-api-key`,
`vertex-ai`, `gateway`.

- **OAuth** is delegated to the CLI: an ACP `authenticate` call makes gemini
  open the browser and persist the credential itself. There is no code to paste
  back, so the login card polls status until it flips.
- **API key** is written to `~/.gemini/.env` (a documented gemini-cli load path)
  with mode `0600`, and applied to `process.env` immediately so an
  already-running backend can spawn authenticated processes without a restart.

A successful login stops idle runtimes so the next prompt respawns with the new
credential — a running Gemini process resolves credentials once, at startup.

## MCP

Gemini keeps MCP servers in `settings.json` under a top-level `mcpServers` map,
and gates them with `mcp.allowed` / `mcp.excluded` name lists:

```text
~/.gemini/settings.json          user scope
<worktree>/.gemini/settings.json project scope (wins on name collision)
```

Elevenex edits those files directly rather than shelling out to
`gemini mcp enable|disable`, because those subcommands refuse to operate in a
folder Gemini considers untrusted — the normal state for a fresh worktree.
Toggling a server adds/removes it from `mcp.excluded` in the scope that defines
it, then stops any idle runtime so the next prompt picks up the new set.

Elevenex passes an **empty** `mcpServers` list over ACP: Gemini loads the same
config itself at `session/new`, and re-declaring the servers would register them
twice. Connection health is reported as `unknown` rather than `connected`
because Gemini owns the connections and does not expose their state over ACP.
Browser-based MCP auth is not implemented, same as Codex.

## Session History, Fork, and Rewind

Gemini writes conversations to:

```text
~/.gemini/projects.json                        lowercased abs path -> project name
~/.gemini/tmp/<project>/.project_root          lowercased abs path
~/.gemini/tmp/<project>/chats/session-*.jsonl  one file per session
```

Each chat file is an **append-only mutation log**, not one-message-per-line: the
first line is a header (`sessionId`, `projectHash`, `startTime`, `kind`) and
every later line is a patch such as `{"$set":{"messages":[...]}}`. Because
`$set` replaces wholesale, materializing a conversation means folding the
patches in order and taking the final `messages` array.

- **History** on a warm runtime comes from the `session/load` replay buffer; on
  a cold one it is parsed from the chat file, so opening a session does not
  spawn a process.
- **Fork** materializes the parent file, truncates at the anchor (a user anchor
  is dropped and returned as the child's draft; an assistant anchor is kept),
  and writes a new chat file under a fresh session id.
- **Rewind** truncates the file in place and drops the live process, so the next
  prompt re-loads the session with only the retained messages.

## Capabilities

```ts
{ mcp: true, subagents: false, permissions: true, userInput: false,
  multimodalPrompts: true, terminalFallback: false, rewindConversation: true }
```

`subagents` is false because ACP reports no separate subagent transcripts.
`userInput` is false because ACP has no elicitation channel distinct from
permissions. `terminalFallback` is false because that path is Claude-specific
(claude binary, claude hooks, claude session resume in `pty-manager.service.ts`)
rather than a generic "run this provider's TUI" surface.

## Auxiliary AI Flows

Commit messages, session titles, and worktree context analysis run through
`TextAgentGenerationService`. For Gemini these use the **non-interactive** path
rather than the ACP session machinery, because they need one block of text
rather than a conversation:

```text
gemini -p <prompt> --output-format json --approval-mode plan --skip-trust
```

`--approval-mode plan` keeps the turn read-only. The JSON envelope is
`{ session_id, response?, stats?, error?, warnings? }`; startup warnings can
precede it on stdout, so the parser scans for the envelope rather than assuming
stdout is pure JSON. No model is pinned by default, so the account's own default
applies.

## Not Yet Verified Against a Live Account

The handshake, auth-method list, mode list, model list, command list, JSON
envelope, MCP settings shape, and chat-file format above were all observed
directly. The following depend on an authenticated turn and should be confirmed
the first time a real account is connected:

- The exact `tool_call` / `tool_call_update` field population (especially where
  gemini puts the tool's own name) and the resulting tool-card mapping.
- The message `type` and part shapes assistant entries take in the chat file,
  which the cold-start history parser reads defensively.
- Fork and rewind round-tripping through `session/load` after a file rewrite.
