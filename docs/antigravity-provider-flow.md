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

**Nothing below has been verified against a live `agy` process.** It is the best
reading of Google's public docs (`antigravity.google/docs/cli/*`), cross-checked
across independent fetches where possible, at the time this was written. Treat
every "Not confirmed" item as the first thing to correct once a real session runs
against an installed binary — see the section at the bottom.

## Runtime Flow

1. The frontend connects to `/agent-runtime?sessionId=<id>&provider=antigravity`.
2. `AgentRuntimeGateway` resolves the `antigravity` provider from
   `AgentRuntimeRegistryService`.
3. `AntigravityAgentRuntimeProvider` delegates execution to
   `AntigravityRuntimeService`.
4. `AntigravityRuntimeService` starts an `AntigravityProcessClient`, which spawns
   `agy --input-format stream-json --output-format stream-json` (plus permission/
   model/effort flags — see below) in the session worktree.
5. Every process start is a fresh conversation — there is no confirmed resume
   mechanism (`--conversation <id>` exists as a flag but is unverified), so
   `session/load`-style replay is not implemented.
6. The client writes one line per user turn (`{"event":"user","message":
   {"content":"..."}}`) and reads back a stream of `init` / `step_update` /
   `result` lines, translated into the same transcript item shape rendered by
   the existing workspace UI.
7. `agy`'s own conversation id (from the `init` event, when present) is stored in
   `sessions.antigravity_session_id` for future use, but is not currently used to
   resume anything.

One `agy` process runs per Elevenex session rather than one shared server,
mirroring the old Gemini provider rather than Codex's shared app-server: `agy`'s
`cwd` is fixed at spawn (no per-turn cwd parameter in the stream protocol), and
sessions live in different worktrees. Processes are reference-counted against
attached clients, shut down after `ANTIGRAVITY_RUNTIME_IDLE_MS` (default 5 min)
idle, and capped at `ANTIGRAVITY_RUNTIME_IDLE_CAP` (default 20) idle instances.

## Stream Protocol

Confirmed flags: `-p`/`--print` (one-shot), `--output-format text|json|stream-json`,
`--input-format stream-json` (paired with `--output-format stream-json`, keeps one
process alive reading one JSON line per turn from stdin), `--model`, `--effort`
(low/medium/high), `--continue`/`-c`, `--conversation <id>`, `--print-timeout`
(default 5m), `--dangerously-skip-permissions`, `--sandbox`.

`stream-json` output is documented as: one `init` event, many `step_update` events
(text deltas, `tool_info: {name, parameters, output, error}`, token usage), one
`result` event per turn with a `status` field (`SUCCESS`, `ERROR`, `CANCELED`,
`INTERRUPTED`, `INVALID`, `WAITING`, `RUNNING`).

**Not confirmed:** the exact field names above (`antigravity-runtime.types.ts` is
written defensively — `type` is read from either `type` or `event`, unknown fields
are optional — so a wrong guess degrades rather than crashes a session); whether
`tool_info` streams incrementally (start, then a later update with output) or
arrives as one complete record. `AntigravityRuntimeService.handleToolInfo`
currently treats every `tool_info`-bearing event as a self-contained call (no id to
correlate multiple events for one call), which will show two cards instead of one
updating card if the real protocol streams tool output incrementally.

`AntigravityProcessClient.interrupt()` sends `SIGINT` as a best-effort mid-turn
cancel — `agy`'s stream protocol documents no cancel event (unlike ACP's
`session/cancel` or a JSON-RPC notification) — and the caller falls back to
killing/respawning the process if that doesn't unblock it.

## Permission Model

**There is no confirmed bidirectional permission-request channel** in `agy`'s
stream protocol — nothing permission-shaped appears in the documented event list.
Headless mode instead runs on a policy chosen at spawn time:

- Default: unapproved tool calls are **soft-denied** (the turn continues, exits 0,
  a warning goes to stderr) unless pre-approved via `permissions.allow` rules in
  `~/.gemini/antigravity-cli/settings.json`. Elevenex does not currently write
  those rules.
- `--dangerously-skip-permissions`: auto-approves everything.

Elevenex maps its permission-mode picker onto these two states rather than a live
approve/deny UI: `default`/`acceptEdits`/`auto` → default policy (no flag),
`bypassPermissions`/`dontAsk` → `--dangerously-skip-permissions` (the closest
equivalent to Gemini's `yolo` mode). "Plan mode" has no `agy` equivalent — enabling
it just forces the default (safest) policy rather than unlocking any special
read-only enforcement. Because posture is chosen at spawn time, changing it
restarts a warm process so the next prompt picks up the new flags.

Because there is no permission channel, `AntigravityAgentRuntimeProvider` declares
`capabilities.permissions: false` and does not implement `approvePermission`/
`denyPermission` — the workspace does not show a permission UI for this provider.

## Models

**Not confirmed:** the real model id list. No catalog page was found during
research, so `getModelCatalog()` honestly reports `supportsModelSelection: false`
and an empty model list rather than fabricate ids that could send a broken
`--model` value. `--model`/`--effort` flags are still wired up and used if a
session ever gets a `selectedModel`/`reasoningEffort` some other way (e.g. once a
real catalog is confirmed and this is revisited).

## Auth

**Not confirmed:** login subcommands, credential storage location, or a cheap way
to probe "is this authenticated" the way `GeminiAuthService` probed via an ACP
`session/new` call. `AntigravityAuthService` only reports whether `agy` is
installed (`agy --version`, cached 1h); `startLogin`/`cancelLogin`/`continueLogin`
reject with a message pointing the user at running `agy` interactively once to
sign in.

Because `authenticated` can never honestly report `true`, `antigravity` is
deliberately **not** in the frontend's `LOGIN_CARD_PROVIDERS` set (unlike Codex,
Pi, and the old Gemini provider) — gating the workspace on
`providerAuthStatus().authenticated === true` would lock every Antigravity
session out permanently with no way through. Instead, the chat UI is always
shown; a genuinely unauthenticated `agy` process simply fails its first prompt,
which surfaces through the normal run-error path. Revisit this once a real auth
probe exists.

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
`TextAgentGenerationService.generateWithAntigravity`, using `agy`'s non-interactive
print mode rather than the stream-json session machinery:

```text
agy -p <prompt> --output-format json [--model <model>]
```

No `--dangerously-skip-permissions` flag is passed, so these read-only text tasks
run under `agy`'s default (soft-deny) policy. The JSON envelope shape is
unconfirmed — `parseAntigravityEnvelope` scans stdout defensively (first/last
top-level `{`) rather than assuming a fixed prefix, the same way the old Gemini
parser did for gemini-cli's envelope.

## Not Yet Verified Against a Live Install

None of this document has been checked against a running `agy` process — the
binary was not available on the machine this was written on. Before relying on
this provider in production, confirm (roughly in priority order):

1. The exact `stream-json` event field names (`init`/`step_update`/`result` and
   `tool_info`), and whether tool calls stream incrementally.
2. Whether `--output-format json` in print mode returns the envelope shape
   `parseAntigravityEnvelope` expects (run `agy -p "say hi" --output-format json`
   directly — the cheapest possible check).
3. Real login/auth flow and credential storage, so `AntigravityAuthService` can
   report actual authentication status and implement `startLogin` for real.
4. The real model id list, so `getModelCatalog()` can stop reporting
   `supportsModelSelection: false`.
5. Whether `agy` maintains a parseable on-disk conversation log, to build a real
   history/fork/rewind implementation instead of the in-memory accumulator.
6. Whether `--conversation <id>` reliably resumes a prior conversation, to wire up
   session resume instead of always starting fresh.
