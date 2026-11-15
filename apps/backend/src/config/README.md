# Subprocess environments

`system-paths.ts` owns bounded global and per-worktree login-shell captures,
binary discovery and environment assembly. `ShellEnvService` warms the global
capture at startup; HTTP activity schedules throttled refreshes.

`shell-refresh-queue.ts` owns admission, priorities, coalescing, queue deadlines
and cancellation. `account-shell.ts` isolates NSS/LDAP account discovery in one
memoized worker. `binary-paths.ts` owns bounded executable discovery and its
short validation cache. The application service closes the queue, captures and
account worker on shutdown.

Global refreshes replace the previous shell-owned projection instead of merging
indefinitely into `process.env`. Launch-time settings and later application
overrides keep priority. Shell-added exports removed from a later capture are
removed from the projection; changed exports update. Failed captures retain the
last good cache and projection.

Capture baselines retain the launch/application environment, including arbitrary
startup inputs such as `HOME`, `ZDOTDIR`, XDG directories and `NVM_DIR`. They
remove our previous shell projection and transient state (`PWD`, prompts,
`FNM_MULTISHELL_PATH`, `NVM_BIN`, `NVM_INC`) and rebuild the startup PATH. This
keeps custom bootstrap settings without accumulating previous shell exports.
Explicit launch/application settings also take priority in worktree startup.
With no `SHELL`, use the account's login shell before the platform fallback.
Global captures start at home;
worktree captures start in the requested directory. Captures use NUL-delimited
`/usr/bin/env -0` output so multiline values remain intact instead of becoming
spurious variables. This is supported by GNU env and [macOS env](https://github.com/apple-oss-distributions/shell_cmds/blob/main/env/env.c).

Only explicit launch/application values override worktree exports; values from
our global shell projection do not override worktree changes or unsets. Binary
lookups follow current PATH/PATHEXT and recheck cached executables for removed
version-manager links. Process-launch paths use `findBinaryAsync`; concurrent
lookups coalesce and positive results are reused for one second. Explicit model
refresh invalidates this cache. The synchronous compatibility API can reuse
these results; legacy calls before warm-up may still perform synchronous I/O.
New Codex/Claude processes resolve their binary after
environment warm-up; already running agents retain their process and environment.

`SSH_AUTH_SOCK` follows successful interactive login-shell captures, including
shell-selected agents and explicit unsets. Explicit child-environment overrides
still take priority. Remote launchers can identify their reconnectable proxy with
`ELEVENEX_SSH_AGENT_PROXY`; `ssh-agent-environment.ts` then reads the daemon's
private one-byte availability file before shell startup. When SSH supplied no
agent, the shell receives no socket, allowing conditional rc-file agent setup
to behave normally. Presence means SSH/the remote account supplied a socket,
not that a key is loaded or that signing is allowed. No key probes are performed.

One owned directory watcher follows atomic availability changes and invalidates
global/worktree captures only when agent presence changes. In-flight captures
are cancelled and stale required reads fail with a retryable setup error; prompts
and mutations are never replayed. Subsequent captures reread the bounded file,
including when watch notifications are unavailable. Warm launches use memory
only. Disposal closes the watcher and capture queue. Legacy launchers without
the marker retain their original transport defaults; the presence-aware startup
requires both an updated remote launcher and backend.

## Slow shells and resource tuning

Warm global/worktree reads return the last successful environment immediately,
including while a background refresh is queued or running. Failed refreshes
retain that environment. Failed cold captures are throttled to avoid repeated
shell launches. Cold callers have a deadline across global and worktree setup;
cancelling a caller stops its later work without killing a capture shared by
other callers. Captures already started may finish and warm the cache.

Waiting captures are bounded separately from active processes. Required cold
reads run ahead of background refreshes; global setup has reserved admission.
An overloaded or expired required queue request fails with a retryable setup
error. Optional queued work can be dropped on eviction or overload. No queued
job starts after its queue deadline. The cache uses both an LRU entry limit and
a quota charged by serialized environment bytes; this quota is not a JavaScript
heap measurement.

The backend reads these launch settings once. Invalid or out-of-range settings
fail startup with the setting name and bounds, without echoing its value.

| Setting | Default | Allowed range |
| --- | ---: | ---: |
| `ELEVENEX_SHELL_CAPTURE_TIMEOUT_MS` | 15000 | 1000–120000 |
| `ELEVENEX_SHELL_QUEUE_TIMEOUT_MS` | 5000 | 100–30000 |
| `ELEVENEX_SHELL_COLD_WAIT_MS` | 20000 | 100–120000 |
| `ELEVENEX_SHELL_BOOTSTRAP_WAIT_MS` | 8000 | 0–30000 |
| `ELEVENEX_SHELL_CAPTURE_CONCURRENCY` | 2 | 1–8 |
| `ELEVENEX_SHELL_MAX_PENDING_CAPTURES` | 128 | 1–1024 |
| `ELEVENEX_SHELL_CACHE_ENTRIES` | 256 | 16–2048 |
| `ELEVENEX_SHELL_CACHE_BYTES` | 16777216 | 1048576–134217728 |

Capture time includes account lookup and shell startup/shutdown. Backend
readiness waits only for the bootstrap budget; a longer capture continues in
the background. A cold caller reaching its wait budget receives a preparing
error and can retry after startup completes. Raising a capture timeout does
not raise HTTP/IPC request deadlines or replay any agent prompt.

Local and SSH desktop launchers preserve only these named tuning settings from
their own launch environment. For SSH, configure the remote process environment;
exports on the Mac are not automatically forwarded. Restart the desktop/local
backend or the remote daemon to apply changed launch settings. Login-shell
exports discovered after launch do not change the budgets for that process.

In SSH mode, agent CLIs and their authentication belong to the remote
backend host. A CLI installed on the desktop Mac is not available to the remote
backend. Install the desired CLI there, or configure `ELEVENEX_CODEX_BIN` /
`ELEVENEX_CLAUDE_BIN` in the backend's environment for a custom executable path.
Refresh the agent models after changing the installation or shell configuration.

FNM's [shell initialization](https://github.com/Schniz/fnm/blob/master/src/commands/env.rs)
creates a unique `fnm_multishells/<id>/bin` directory per POSIX shell
(`fnm_multishells/<id>` on Windows). Exact PATH deduplication cannot prevent these
from accumulating. Environment assembly retains only the first FNM multishell
entry, preserving PATH priority and all ordinary tool directories. This also
repairs already inflated inherited paths. Worktree captures take priority over
the global PATH so project-specific Node versions still apply. No directories
or version-manager files are deleted.

`subprocess-environment.ts` tracks projection ownership and checks captures and
assembled child environments before use. The conservative budget is 128 KiB
including string terminators and pointer overhead, with at most 64 KiB per
entry, leaving room for command arguments and provider-added settings. This is
an environment budget, not a guarantee that arbitrary argument lists fit the
host's exec limit. Oversized captures/projections retain the last good state;
oversized caller overrides fail explicitly without truncating or dropping
credentials. Diagnostics include only counts, byte sizes and up to five bounded
variable names, never values. Normal Git/agent configuration and credentials
continue to flow through the existing environment builders.

Backend source edits require restarting `pnpm desktop:dev` to rebuild its engine.
A renderer refresh does not update backend code or an already running agent.
