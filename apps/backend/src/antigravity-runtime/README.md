# Antigravity runtime

The backend starts the machine’s official `agy acp` executable in a task’s
worktree. The CLI owns credentials and tool execution. The runtime accepts
prompts and manual queue resumes only from the named desktop chat command
path. The command handler sets the internal origin after validating the action
and its task/session scope. MCP and workspace automation do not supply that
origin.

`AcpStdio` owns the subprocess and the bounded newline-delimited JSON-RPC
transport. The provider owns one process per active Elevenex conversation and
reuses it for adjacent turns. Stop cancels native work and pending decisions,
with a bounded process shutdown if the CLI does not settle. Idle processes
expire. Reconnect resumes the saved native session on the next explicit send,
without redispatching an interrupted turn.

Conversation processes use `agy acp --process-per-session` to enable ACP's HTTP
MCP transport. When the CLI advertises HTTP MCP support, the provider passes the
shared Elevenex MCP endpoint and the conversation's session bearer on
each new, loaded, or resumed connection. This gives Antigravity the same tool
catalog and caller identity as the other coding harnesses. The catalog probe
uses a temporary session with an empty MCP server list.

`AntigravityTurn` projects ACP updates to stable transcript items.
`AntigravityDecisions` presents native permission options, fixed-choice questions
and form requests in order. Stop and disposal cancel pending decisions. The
conversation client serves ACP text reads within the active task workspace and
its own uploaded attachments through the confined Code reader. The CLI owns
writes and command execution. Catalog and title helpers have no file capability.
The session row retains the native ID and session model and mode preferences. SQLite
stores the user receipt at dispatch and finalizes that turn’s transcript in the
same row at settlement. Desktop history reads do not spawn the CLI.
The shared turn-change service supplies the worktree review.

When the first desktop prompt is dispatched for a session with a default name,
Elevenex asks Antigravity's default model for a short title in a background ACP
session. The helper runs in a temporary directory with sandbox restrictions,
an empty MCP server list and no Elevenex session bearer. It stops on tool or
input requests. It skips profiles with global hooks, MCP servers or installed
plugins because they can run before ACP can refuse a request.

If the helper yields no title, Elevenex uses a title reported by the live ACP
session when available. Otherwise it uses a short excerpt of the first user
message after that turn settles. The rename only applies while the original
placeholder is current. The helper's output stays out of the conversation
transcript, and later prompts do not start another title job.

The engine discovers model options on the first catalog read through an empty
ACP session in a temporary directory. Discovery sends no prompts, coalesces
concurrent reads, closes the session, and caches the advertised defaults for
settings and new conversations. Each task conversation still receives its
own options when it connects.

The same catalog probe discovers native Plan, Accept edits and Auto. The
Plan/Code switch preserves the selected Code permission policy. Elevenex
stores both choices in the existing session JSON and applies the native mode
before prompts, including after resume. If a requested native mode is no
longer available or the CLI declines to activate it, the prompt stays unsent.
Full access is an explicit desktop choice for the conversation. It selects
the CLI's default mode and answers tool permission requests with the offered
one-time allowance during a Code turn. Plan, elicitation and native questions
retain their approval flow.

## Usage and quota

`antigravity-usage.ts` reads only what the official CLI reports over ACP:

- `usage_update` (`used`/`size`) is the conversation's context window. The
  provider keeps the last report per conversation, bounded, so it survives idle
  CLI shutdown until the next connection reports again.
- `_meta.antigravity.tier` on session results names the account's quota tier.
  The catalog's discovery session reports it too.
- Antigravity meters quota per model. A `session/prompt` failure classified as
  exhausted quota marks the current model exhausted, with the reset Google
  reports in the error text or details (`reset after 2h3m`,
  `quotaResetTimeStamp`, `retryDelay`). The desktop sees a fixed message, never
  the provider text. A completed turn on that model, or its reported reset,
  clears it. A model without a reported reset is kept for a day at most.

`AntigravityQuota` is account-wide: one instance per provider, shared by every
conversation and pushed to connected ones on change. It is in memory only and
is projected as the optional `SessionChatState.modelQuota`, kept separate from
`planUsage` because supported desktops validate that field strictly.

ACP in agy 1.5 does not report remaining quota fractions. The contract's
nullable `remainingPercentage` accepts them when a supported source exists.
The engine does not read the CLI's credentials or call Google's internal quota
endpoints.

## Work that outlives a prompt

Finite commands, scheduled wakeups and native subagent batches can keep the
activity view live after `session/prompt` returns. A daemon remains visible
while the composer accepts follow-ups. Stop sends `session/cancel` to the native
session and pauses queued follow-ups. A quiet command expires after 30 minutes
without progress. A scheduled wake with a reported duration has that duration
plus the same grace period.

Antigravity can start a reply without an open prompt, including one that starts
by asking for permission. The provider accepts these replies on the live ACP
connection, uses `usage_update` to settle them, and saves them in conversation
history. A late command receipt is attached to the original tool record.
Reconnect never resubmits an interrupted command or prompt.

The Activity panel can open a read-only view of a subagent batch. The provider
matches launches to child records in the current CLI profile and reads a bounded
tail of each matched transcript. Missing or ambiguous records have unavailable
status. A child's reply to its parent can be a request for guidance, so it does
not establish that the child succeeded. Stop targets the whole native session.

On agy 1.5 or later, a queued follow-up can steer an open prompt. ACP supplies the
slash commands through the runtime autocomplete endpoint. The conversation
forwards native commands such as `/compact` and `/goal` when the installed CLI
advertises them. Images and eligible audio, PDF and UTF-8 text uploads use the
CLI's advertised ACP prompt capabilities. Uploads also retain their file link
for runtimes or file types that require a path.

Edit from here keeps earlier messages and starts a fresh native session for
the revised message. Elevenex quotes a bounded recent slice of the retained
history, preserving review links and read-only subagent history for earlier
turns. Prompts saved before editing support and native slash commands remain
read-only.

Elevenex uses the installed CLI and its existing sign-in profile. Managed CLI
installation and accounts, and Antigravity-specific skill suggestions are
currently unavailable.
