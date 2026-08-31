# Antigravity CLI Provider Flow

Elevenex exposes Google's Antigravity CLI (binary `agy`) through the existing agent
runtime provider registry. Claude Code remains the default provider and keeps its
own session id, permissions, MCP handling, terminal fallback, and transcript
behavior.

**`agy` does not speak the Agent Client Protocol (ACP)** that Claude, Codex, Pi,
and the old Gemini CLI provider all use. There is an open, unimplemented feature
request for it ([google-antigravity/antigravity-cli#31](https://github.com/google-antigravity/antigravity-cli/issues/31)),
and the only ACP-speaking option is unofficial third-party adapter binaries, which
Elevenex deliberately does not depend on (supply-chain risk for a tool that
mediates every prompt, file edit, and credential in a session). Instead, this
provider drives `agy`'s own native headless protocol directly.

**Verified against `agy` 1.1.22 on Windows, and re-verified end to end on macOS**
by replaying live captured stream-json sessions (text-only turns, read/list/grep/
glob/edit/write/command/web tools, tool failures, auto-denied tools, interrupts,
and resume) through the real parsing pipeline. The sections below describe
observed behavior. Items still unconfirmed are called out explicitly.

## Runtime Flow

1. The frontend connects to `/agent-runtime?sessionId=<id>&provider=antigravity`.
2. `AgentRuntimeGateway` resolves the `antigravity` provider from
   `AgentRuntimeRegistryService`.
3. `AntigravityAgentRuntimeProvider` delegates execution to
   `AntigravityRuntimeService`.
4. `AntigravityRuntimeService` starts an `AntigravityProcessClient`, which spawns
   `agy --input-format stream-json --output-format stream-json --add-dir <worktree>`
   (plus permission/model/effort flags — see below) in the session worktree.
5. Every process start is a fresh conversation — there is no confirmed resume
   mechanism (`--conversation <id>` exists as a flag but is unverified), so
   `session/load`-style replay is not implemented.
6. The client writes one line per user turn (`{"event":"user","message":
   {"content":"..."}}`) and reads back a stream of `init` / `step_update` /
   `result` lines, translated into the same transcript item shape rendered by
   the existing workspace UI.
7. `agy`'s own conversation id (from the `init` event) is stored in
   `sessions.antigravity_session_id` for future use, but is not currently used to
   resume anything.

One `agy` process runs per Elevenex session rather than one shared server,
mirroring the old Gemini provider rather than Codex's shared app-server: `agy`'s
workspace is fixed at spawn (no per-turn cwd parameter in the stream protocol),
and sessions live in different worktrees. Processes are reference-counted against
attached clients, shut down after `ANTIGRAVITY_RUNTIME_IDLE_MS` (default 5 min)
idle, and capped at `ANTIGRAVITY_RUNTIME_IDLE_CAP` (default 20) idle instances.

## Workspace: `--add-dir` is required

**`agy` does not treat its process cwd as the workspace.** Spawned without an
explicit `--add-dir`, it works out of an empty scratch directory
(`~/.gemini/antigravity-cli/scratch`): `list_dir .` fails with "path is not
absolute", the agent resolves `.` to the scratch path, and it reports the
repository as empty. Every file and command tool then operates on the wrong
directory.

Both entry points therefore pass `--add-dir <worktreePath>`:
`AntigravityRuntimeService.resolveSpawnArgs` for chat sessions, and
`TextAgentGenerationService.generateWithAntigravity` for the one-shot text
flows. Passing `cwd` to `spawn` is not sufficient and never was.

## Stream Protocol

Confirmed flags: `-p`/`--print` (one-shot), `--output-format text|json|stream-json`,
`--input-format stream-json` (paired with `--output-format stream-json`, keeps one
process alive reading one JSON line per turn from stdin), `--model`, `--effort`
(low/medium/high), `--mode accept-edits|plan`, `--add-dir` (repeatable),
`--continue`/`-c`, `--conversation <id>`, `--print-timeout` (default 5m),
`--dangerously-skip-permissions`, `--sandbox`, `--disable-slash-commands`,
`--json-schema`.

Every output line is an **envelope whose payload is nested under a key named
after the event**, not flattened onto the envelope:

```jsonc
{"event":"init","conversation_id":"...","init":{"cwd":"...","tools":[...],"permission_mode":"request-review"}}
{"event":"step_update","step_update":{"step_index":1,"state":"DONE","step_type":"agent_response","text_delta":"Hi\n","usage":{...}}}
{"event":"result","result":{"conversation_id":"...","status":"SUCCESS","response":"Hi\n","num_turns":1,"usage":{...}}}
```

`AntigravityProcessClient.handleLine` flattens the payload onto the envelope
before emitting, so everything downstream sees one flat event. Reading
`status`/`response`/`text_delta`/`tool_info` off the envelope directly — as the
first implementation did — yields `undefined` for every field, which is why the
chat rendered nothing at all.

Field notes:

- Assistant prose arrives as `text_delta` on `agent_response` steps (not `delta`),
  and is then repeated in full in `result.response`. Only fall back to
  `result.response` when nothing streamed, or the message renders twice.
- `step_type` is `user_input` | `agent_response` | `tool`.
- **Tool calls stream incrementally and `step_index` is the correlation key**: a
  call arrives as `state: "ACTIVE"` (parameters only), then `state: "DONE"` or
  `"ERROR"` carrying `output`/`error`. `handleToolInfo` keys its transcript card
  on `step_index` so one call renders as one updating card.
- **`tool_info.error` is an object** (`{type, message}`), not a string.
- A tool that headless mode auto-denied settles as `DONE` with **neither**
  `output` nor `error`, so the card must be closed on `state`, not on the
  presence of a result.

- **`thought: true` was never observed.** `usage.thinking_tokens` is reported, but
  reasoning text is not streamed, so the thinking-bubble path is currently dead
  code kept for a future `agy` that does stream it.
- **`ask_question` is invisible.** When the agent asks the user something, `agy`
  emits a bare `{"step_type":"unknown","state":"DONE"}` step with no `tool_info`
  and no text — the question itself never reaches the stream. Nothing can be
  rendered for it, which is why `pendingUserInputRequest` is never populated and
  `capabilities.userInput` is `false`.

### Interrupt: SIGINT kills the process

`AntigravityProcessClient.interrupt()` sends `SIGINT`, because `agy`'s stream
protocol has no cancel event. What `agy` actually does with it is **not** the
usual "abort the turn, keep the REPL alive":

```text
result { status: "ERROR", error: "timeout waiting for response", response: "" }
child exits with code 1
```

Two consequences the implementation has to absorb. `handleTurnResult` checks the
interrupt flag *before* the status, or every stop-button press renders as a red
`timeout waiting for response` error; and `handleRuntimeExit` does the same,
since the process death arrives as an unexpected exit. The next prompt respawns
and picks the thread back up via `--conversation` (below).

### Conversation resume works

`--conversation <id>` **does** resume: a fresh process started with a prior
conversation id reports that same id in its `init` event and the model still has
the thread (verified by asking it to recall a number from a killed process).
`--continue` resumes the most recent conversation. An unknown id is not fatal —
`agy` warns `conversation "…" not found` on stderr and starts fresh.

`resolveSpawnArgs` therefore passes `--conversation <state.antigravitySessionId>`
whenever the session has one. Without it, the 5-minute idle shutdown, any
model/effort/permission change (which restarts the warm process), and every
interrupt silently started a brand-new conversation mid-session. Resume restores
the *model's* thread only; `agy` replays no past steps into the stream, so
Elevenex's own transcript is still the in-memory one described below.

## Permission Model

**There is no bidirectional permission-request channel** in `agy`'s stream
protocol. Headless mode runs on a policy chosen at spawn time:

- Default (`permission_mode: "request-review"`): a tool call needing approval is
  **auto-denied**, because there is no way to prompt. `agy` writes a warning to
  stderr (`jetski: no output produced — a tool required the "command" permission
  that headless mode cannot prompt for...`).
- `--dangerously-skip-permissions`: auto-approves everything.

The consequence matters: **an auto-denied tool call ends the turn with an empty
response**, reported as either `status: "CANCELED"` or even `status: "SUCCESS"`
with `response: ""`. Neither is an error, so a naive implementation just stops
with a blank chat. `AntigravityRuntimeService` treats both as a failure and
surfaces an actionable message pointing at the permission-mode picker; a
`CANCELED` turn is only reported as a clean interrupt when the user actually
requested one.

`agy` exposes **no "auto" posture** on the CLI: the only permission-related flags
are `--dangerously-skip-permissions`, `--mode accept-edits|plan`, and `--sandbox`.
The binary does carry a richer internal policy model (`autoExecPolicy`,
`TERMINAL_COMMAND_AUTO_EXECUTION_POLICY_{REQUIRE_REVIEW,PROCEED_IN_SANDBOX,NOT_ENFORCED}`,
`permissionsV2` grants), but none of it is reachable through a flag.

**`--mode accept-edits` does not help headlessly.** Its own flag help says
"auto-approve file edits, prompt for commands", but verified on `agy` 1.1.22
(macOS) both creating a new file and editing an existing one under `--add-dir`
are auto-denied with the same `write_file` message; the turn ends `SUCCESS` with
`response: ""`. Only the bypass modes can actually run write/command tools. Read-only
tools (`list_dir`, `read_file`) do work without any flag.

Elevenex maps its permission-mode picker onto `agy`'s spawn-time flags:
`bypassPermissions`/`dontAsk` → `--dangerously-skip-permissions`, `acceptEdits` →
`--mode accept-edits`, plan mode → `--mode plan`, and `default` → no flag. Because
posture is chosen at spawn time, changing it restarts a warm process so the next
prompt picks up the new flags.

**New sessions start in `bypassPermissions`** (`ensureRuntimeState`). Starting in
`default` meant every fresh Antigravity session failed on its first write or
command tool with the empty-turn diagnostic, and no other mode can run those
tools, so bypass is the only usable default for this provider.

### Unimplemented alternative: `permissions.allow` grants

`agy`'s auto-deny message points at a third path Elevenex does not use yet: an
allow-rule under `permissions.allow` in `~/.gemini/antigravity-cli/settings.json`.
Rules must match `^(command|read_file|write_file|read_url|mcp|execute_url|unsandboxed)\s*\(.*\)$`
— i.e. `write_file(<target>)`, `command(git)`, `read_file(*)`; a bare tool name is
not a valid rule. The binary's changelog also notes per-project permission config
in `~/.gemini/config/projects/` takes precedence over the global settings file.
Wiring this up would make `default`/`acceptEdits` genuinely meaningful instead of
dead ends, but it means Elevenex writing into the user's global `agy` config, so it
is deliberately not done here.

Because there is no permission channel, `AntigravityAgentRuntimeProvider` declares
`capabilities.permissions: false` and does not implement `approvePermission`/
`denyPermission` — the workspace does not show a permission UI for this provider.

## Tool Taxonomy

`agy` reports 57 tools in its `init` event and names **none** of them the way
Claude/Codex/Gemini do. It also spells every parameter in PascalCase. Captured
live:

| `agy` tool | parameters | renders as |
| --- | --- | --- |
| `view_file` | `AbsolutePath` | Read |
| `list_dir` | `DirectoryPath` | List |
| `find_by_name` | `Pattern`, `SearchDirectory` | Glob |
| `grep_search` | `Query`, `SearchPath` | Grep |
| `run_command` | `CommandLine`, `Cwd` | Bash |
| `write_to_file` | `TargetFile` | Write |
| `replace_file_content` | `TargetFile` | Edit |
| `read_url_content` | `Url` | WebFetch |
| `search_web` | `query` (the one lowercase outlier) | WebSearch |

`AGY_TOOL_MAP` in `antigravity-transcript.ts` maps names onto aliases the shared
`canonicalizeAgentTool` understands and renames parameters onto the keys the tool
cards read (`file_path`, `command`, `pattern`, `path`, `url`), keeping the
originals so the raw parameter view stays complete. Without it exactly one tool
(`notebook_edit`) matched the shared table and every other Antigravity tool call
rendered as a generic `unknown` card full of raw JSON.

Tools with no counterpart in the shared taxonomy — the `browser_*` family,
subagent and task management, `command_status`, `finish`, `wait` — deliberately
stay `unknown`, which shows the raw name and parameters.

Two payload notes that matter for rendering: parameters are **redacted to
identifiers**, so `write_to_file` carries no content and `replace_file_content`
carries no diff (the Write/Edit cards therefore show a path and no body), and
`view_file`'s `output` is a summary line like `"8 lines, 93 bytes"` rather than
the file text.

## Models

`agy models` lists real ids (`gemini-3.7-flash-high`, `gemini-3.1-pro-high`,
`claude-sonnet-4-6`, `gpt-oss-120b-medium`, …), so a catalog is now obtainable.
`getModelCatalog()` still reports `supportsModelSelection: false` and an empty
list: it is synchronous, and wiring a real catalog needs the async refresh-and-
cache plumbing the Claude and Pi providers have. `--model`/`--effort` are wired
up and used if a session gets a `selectedModel`/`reasoningEffort`. Note that
reasoning effort is baked into most model ids (`-high`/`-medium`/`-low`), which
overlaps with `--effort`; that interaction is unverified.

## Auth

**Not confirmed:** login subcommands or credential storage location.
`AntigravityAuthService` only reports whether `agy` is installed (`agy --version`,
cached 1h); `startLogin`/`cancelLogin`/`continueLogin` reject with a message
pointing the user at running `agy` interactively once to sign in.

`agy models` performs a server round-trip and so would work as a real
authentication probe, but it is not wired up as one yet.

Because `authenticated` can never honestly report `true`, `antigravity` is
deliberately **not** in the frontend's `LOGIN_CARD_PROVIDERS` set (unlike Codex,
Pi, and the old Gemini provider) — gating the workspace on
`providerAuthStatus().authenticated === true` would lock every Antigravity
session out permanently with no way through. Instead, the chat UI is always
shown; a genuinely unauthenticated `agy` process simply fails its first prompt,
which surfaces through the normal run-error path.

## MCP

Confirmed (two independent fetches of the official MCP doc page): `agy` keeps MCP
servers in JSON config files:

```text
~/.gemini/config/mcp_config.json   user scope (path name inherited from gemini-cli)
<worktree>/.agents/mcp_config.json project scope (wins on name collision)
```

Format: `{"mcpServers": {"name": {"command"|"serverUrl", "args", "env", "headers",
"disabled", "disabledTools"}}}` — each server gated by its own `disabled` boolean,
unlike Gemini's `mcp.allowed`/`mcp.excluded` name lists. Elevenex edits those files
directly (no documented `agy mcp enable|disable` subcommand, only the interactive
`/mcp` overlay). `agy` reads this config once at process start, so toggling a
server stops any idle runtime for that session so the next prompt picks up the
change. Connection status is reported `unknown` — `agy` owns the connections and
does not expose their health over the headless protocol.

## Session History, Fork, and Rewind

**Not confirmed:** whether `agy` maintains a stable, parseable on-disk conversation
log. Its `/resume` interactive command implies *some* persisted log exists, but its
format is undocumented. Rather than guess a file format the way
`GeminiHistoryService` could for gemini-cli's chat files, Elevenex accumulates
transcript items **in memory per session** (`AntigravityRuntimeService`'s
`sessionHistories` map) for as long as the backend process stays up. This means:

- History survives tab switches and idle-process shutdown/respawn (it's kept in
  the service, not the child process).
- History is **lost on backend restart** — a real limitation until the on-disk
  format is confirmed and a proper history service is written.
- Fork and rewind are not implemented (`capabilities.rewindConversation: false`,
  no `forkConversation` on the provider) for the same reason.

## Capabilities

```ts
{ mcp: true, subagents: false, permissions: false, userInput: false,
  multimodalPrompts: false, terminalFallback: false, rewindConversation: false }
```

`subagents` is false because `agy` reports no separate subagent transcripts over
the stream protocol. `permissions` is false per the Permission Model section above.
`multimodalPrompts` is false because no image/attachment content-block shape was
found in the stream protocol docs. `terminalFallback` is false for the same reason
it's false everywhere except Claude — that path is Claude-specific
(`claude` binary, claude hooks, claude session resume in `pty-manager.service.ts`).
`rewindConversation` is false per the Session History section above.

## Auxiliary AI Flows

Commit messages, session titles, and worktree context analysis run through
`TextAgentGenerationService.generateWithAntigravity`.

These want a single block of text, so print mode (`agy -p <prompt>`) looks like
the natural fit — but **print mode only accepts the prompt as a command-line
argument and does not read stdin**. A commit-message prompt embeds a diff (up to
24k chars) plus convention docs (up to 6k), which on Windows exceeds the ~32k
command-line limit: the spawn fails outright with `ENAMETOOLONG`, deterministically,
for any non-trivial change. This is why commit-message generation appeared broken
while working fine on tiny diffs.

The one-shot flows therefore reuse `AntigravityProcessClient` and send the prompt
as one NDJSON line on stdin, where size is a non-issue:

```text
agy --input-format stream-json --output-format stream-json \
    --add-dir <worktree> --disable-slash-commands [--json-schema <schema>] [--model <model>]
```

- `--disable-slash-commands` stops a diff line beginning with `/` from being
  expanded as a slash command.
- `--json-schema` makes `agy` return a validated object in `structured_output`,
  which `readAntigravityText` prefers over `response` (the latter carries markdown
  fences, a restated copy of the JSON, and trailing tool chatter). `git.service`
  passes `COMMIT_MESSAGE_JSON_SCHEMA` for commit messages.
- No `--dangerously-skip-permissions`, so tool calls are auto-denied. Since a
  denied call ends the turn empty, the prompt is prefixed with
  `ANTIGRAVITY_NO_TOOLS_PREAMBLE` instructing the model to answer directly from
  the message. Without it the model reaches for `run_command`, gets denied, and
  returns nothing.

## Still Unverified

1. Real login/auth flow and credential storage, so `AntigravityAuthService` can
   report actual authentication status and implement `startLogin` for real
   (`agy models` is a candidate probe).
2. An async model catalog, so `getModelCatalog()` can offer the ids `agy models`
   returns, and how `--effort` interacts with effort-suffixed model ids.
3. Whether `agy` maintains a parseable on-disk conversation log, to build a real
   history/fork/rewind implementation instead of the in-memory accumulator.
   (`--conversation <id>` resume is now verified and wired up, but it restores the
   model's thread, not Elevenex's transcript.)
4. Parameter spellings for the tools that never came up live —
   `multi_replace_file_content`, `sed_file`, `notebook_edit`, `call_mcp_tool`.
   Their entries in `AGY_TOOL_MAP` are inferred; a wrong key just leaves the
   card's target blank rather than breaking it.
5. Whether there is a cleaner mid-turn cancel than `SIGINT`, which kills the
   process outright.
