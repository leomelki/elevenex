# Subprocess environments

`system-paths.ts` owns bounded global and per-worktree login-shell captures,
binary discovery and environment assembly. `ShellEnvService` warms the global
capture at startup; HTTP activity schedules throttled refreshes. Captures retain
the existing concurrency, output, deadline and process-group cleanup limits.

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
version-manager links. New Codex/Claude processes resolve their binary after
environment warm-up; already running agents retain their process and environment.

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
