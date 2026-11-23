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
The session row retains the native ID and session model preferences. SQLite
stores the user receipt at dispatch and finalizes that turn’s transcript in the
same row at settlement. Desktop history reads do not spawn the CLI.
The shared turn-change service supplies the worktree review.

Model options come from the connected ACP session. The bounded engine catalog
retains the most recent advertised options for settings and new conversations.
Follow-ups are queued per conversation. Plan mode, native steering, rewind,
and separate native subagent transcripts are outside this provider’s desktop
capabilities.
