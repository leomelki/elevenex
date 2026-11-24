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

`AntigravityTurn` projects ACP updates to stable transcript items.
`AntigravityDecisions` presents native permission options and form requests in
order, and cancels them on stop or disposal. Tool actions stay inside the CLI.
The session row retains the native ID and session model and mode preferences. SQLite
stores the user receipt at dispatch and finalizes that turn’s transcript in the
same row at settlement. Desktop history reads do not spawn the CLI.
The shared turn-change service supplies the worktree review.

The engine discovers model options on the first catalog read through an empty
ACP session in a temporary directory. Discovery sends no prompts, coalesces
concurrent reads, closes the session, and caches the advertised defaults for
settings and new conversations. Each task conversation still receives its
own options when it connects.

The same catalog probe discovers execution modes. The composer offers the
CLI's advertised choices, including Auto on eligible installations. A selection
is saved in the session's existing JSON preferences and applied via ACP before
each prompt as needed, including after resuming a native session. If the CLI
no longer offers or declines to activate the selected mode, the turn stops
before sending the prompt. Antigravity evaluates tool permissions in the
selected mode and Elevenex relays the permission requests the CLI sends.

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

Follow-ups are queued per conversation. Native steering, rewind,
and separate native subagent transcripts are outside this provider’s desktop
capabilities.
