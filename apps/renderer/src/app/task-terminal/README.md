# Production task terminals

`TaskTerminalComponent` adapts the existing `TerminalView` / `ViewTabs`. The
toolbar shows terminal actions only; directory and branch context belongs in the
shell, where it reflects the user's current directory rather than startup metadata.
The workspace projects it through `WorkspacePanels[workspaceTerminal]`; task identity
is independent of the selected conversation. Terminal data and surfaces activate lazily on first
use. Opening Terminal checks the current task's backend list and starts one shell
if it is empty. Existing tabs (including exited shells) are retained. Each opening
attempts startup once; polling and reconnect never retry it. Hiding or switching
tasks cancels a pending opening before startup. New shell, script launch, interrupt,
rerun and process close remain user actions. There are no agent terminal tools or
chat-output mirrors. Existing agent approval flows are unchanged.

`lastClosed` asks the workspace to close its side panel as soon as the last tab
is removed, while backend cleanup continues. Failed/uncertain closes reconcile
in the background; surviving tabs and errors remain available on reopening.
Cleanup replies never close or reopen the panel. Reopening an empty Terminal
starts a fresh shell; hiding a panel with existing shells only detaches them.

The metadata store owns scoped reads and four task snapshots. The component owns
up to eight xterm surfaces, each with 2,000 scrollback rows, selection, reading
position and a bounded input queue. Eviction disposes a surface, never its PTY.
Observers belong to the visible attachment. Hidden panels are inert and stop
output reads; reconnect and show reattach by task/terminal/generation/offset.
Session changes within a task keep the same surface and process. Switching
machines clears display caches. Closing an individual window detaches while other
windows remain. Quitting the app or closing its last window closes all terminals
created by that app launch, including exited tabs, before releasing the local
engine and SSH transports. Main supplies an opaque app owner; renderers cannot
choose it. Cleanup on remote engines is best effort when their connection is
unavailable. Hiding the pane, switching tasks and reconnecting retain processes.
Task finishing uses the existing strict PTY cleanup.

Desktop records carry a separate nullable owner in the shared terminal table;
legacy records keep their existing durable lifecycle and do not appear as stale
desktop tabs. Engine shutdown removes desktop records after stopping their PTYs;
startup also expires those records after a crash. Reopening the pane on a new
launch therefore finds an empty list and starts one fresh shell, without replaying
scripts or input. Remote terminals survive an interrupted connection until app
cleanup can reach that engine, explicit close, task finish or daemon shutdown.

Closing removes a tab and selects its neighbour immediately while backend process
cleanup continues. Other tabs and actions remain available. Pending closes are
excluded from metadata refreshes, including after task switches. Completion
reconciles the backend list without replaying close; failed or uncertain closes
restore any surviving tab and show an error without replacing the current selection.

Terminal mutations serialize per process, including explicit close and owner cleanup.
Reruns revalidate durable ownership and carry the manager generation captured before
asynchronous work, so task finishing and legacy cleanup can cancel replacement.
App cleanup also waits for accepted reruns.

Main exposes named runtime-validated operations on its existing per-window
backend lease. The additive backend routes live in `user-terminal`, reuse
`UserTerminalService` and `UserPtyManager`, and resolve the durable workspace
before spawning or accepting input. A recorded historical path never selects a
checkout. Desktop PTYs use the manager's direct mode on local and remote engines;
UI disconnects do not detach their operating-system processes. The legacy
WebSocket/tmux contract is unchanged.

Each process owns a random generation and a 256 KiB output window. UTF-16 cursor
identity matches JavaScript on both sides; output responses contain at most
32 KiB characters. The next request waits for xterm's write callback, providing
consumer backpressure without accumulating event batches in Angular. Producer
bursts can expire history; the next response reports a gap and the panel labels
it. Generation changes reset the surface and are labelled. Engine restart expires
desktop records; neither reads nor reconnect start shells. Explicit replacement
through a legacy client can still invalidate an attached stream and is labelled.
One active output read runs at a time; metadata refresh is bounded to 16 tabs.
Script discovery reads one confined root package manifest (256 KiB, 100 scripts),
coalesced/cached for three seconds. Launch and rerun rediscover it.

Input dispatch is serialized, capped at 128 KiB per pending paste and split into
small Unicode-safe requests. Oversize pastes are refused visibly. Input is never
retried. Unknown input outcomes clear pending data, disable typing and require
an explicit Resume typing after inspection. Connection and process generation
changes invalidate pending input. Queued chunks retain their original scope and
process identity; replacement requires explicit Resume typing if a dispatch was
interrupted. Resize is fit-to-container, frame-coalesced and single-flight.

ANSI is rendered by the installed xterm 6 adapter, loaded lazily. Its matching
WebGL addon draws Powerline caps/separators, box drawing and blocks to cell edges,
independent of font ascent, line height and letter spacing. The DOM renderer's
font-only shapes cannot guarantee continuous prompt backgrounds. GPU resources
belong to the visible attachment: hiding/evicting a surface disposes the addon and
explicitly releases its context, while retaining output, selection and the PTY.
GPU initialization failure or unrecovered context loss falls back to the DOM
renderer so shell interaction remains available; shapes then depend on font
metrics. Reattaching attempts WebGL again. OSC 52 clipboard
access and OSC 8 navigation are disabled. A window-owned style lease nonces generated sheets and adapts only the DOM
renderer's finite RGB/underline declarations to CSSOM. xterm 6.0 otherwise uses
CSP-blocked style attributes for truecolor and selections. Arbitrary CSS, raw HTML
and non-span attributes keep the browser's normal CSP path. Leases restore the
DOM factory after the last surface closes; production CSP is unchanged. Native user selection/copy and paste
remain available. Find searches retained scrollback with at most 1,000 matches,
joining soft wraps while preserving Unicode cell coordinates. Enter/Shift-Enter
moves between matches; Escape restores focus. The theme maps
the specification's ANSI palette to authoritative tokens and local Geist Mono.
A bundled symbols-only Nerd Font fallback covers Powerline, Git, Node.js and other
private-use prompt icons; it and the regular/bold text faces load before cell
measurement and leave ordinary text in Geist Mono. See the
[font provenance and licenses](../../../public/fonts/README.md).

Bash/zsh prompt hooks report command start/completion and exit status using a
random per-process token, distinct from the public generation. The token lives in
private temporary rc files and is not exported to child environments. Ordinary or
foreign OSC 133 output cannot enable command capture. This separates untrusted
output; it is not isolation from hostile programs with same-user filesystem/process
access. Bash preserves string/array prompt hooks and their incoming exit status,
and enables capture only after those hooks finish. Both integrations source the
normal user rc then explicitly enter the resolved task worktree. Other shells
remain interactive; per-command status requires their prompt integration. Rerun
uses only a discovered script ID or a reliably captured plain user input line,
including single-line bracketed paste (even when its markers span input requests),
never a command extracted from output. Multiline pastes remain unrepeatable rather
than guessing how the shell interpreted them. Foreground-program input, including hidden
password prompts, is never captured as a shell command. Complex cursor/history editing disables
shell rerun rather than guessing. An unfinished prompt line also disables rerun,
so a repeat cannot concatenate with a person’s unsent input. The failure bar uses Fold; ViewTabs retains
its existing entry/exit, keyboard close and status motion. Initial history stays
still. Failed processes retain output until close.

Ask the agent adds the command, exit code and last 80 rendered lines (8,000
characters) to the selected conversation's existing composer draft. Existing
writing is preserved. It restores chat focus and never sends a prompt. Archived
conversations cannot receive this action.

A recognized localhost HTTP(S) serving port produces `TerminalBrowserIntent`
with scope/task/terminal/port, never an output URL. The workspace selects Browser;
main rechecks the live terminal and opens its service in the system browser.
For SSH, it creates/reuses this window's managed forward and uses its actual
bound local port. The small Browser service handoff is the standalone fallback;
a richer Browser owner can consume the same typed intent without changing the
terminal domain. Detection never itself navigates. Saved forwards retain their existing window-manager lifetime; closing a terminal
does not remove a saved forward.
