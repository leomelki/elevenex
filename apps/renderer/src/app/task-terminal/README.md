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
Reattachment waits for a pending xterm write and its cursor update before reading
another page, so rapid hide/show cannot duplicate output.
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
New launches and reruns revalidate durable ownership and carry the manager generation
captured before asynchronous ownership checks, so task finishing and legacy cleanup
can cancel startup or replacement.
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
an explicit Resume typing after inspection. Detaching, connection and process generation
changes invalidate pending input. Queued chunks retain their original scope and
process identity; replacement requires explicit Resume typing if a dispatch was
interrupted. Resize is fit-to-container, frame-coalesced and single-flight.
Output pages carry their original PTY grid and stop at resize boundaries. The
surface replays them with that grid before fitting the visible pane, without
sending historical resizes back to the process. This keeps zsh's startup spacer
from wrapping into blank rows in narrow panes, including on reattachment. Geometry
history is bounded to 256 boundaries within the retained output window; expiration
uses the existing history-gap notice. Engines without grid metadata retain the
original output contract.

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

Shell integration is an optional launch adapter, independent of PTY output,
input, geometry, process ownership and script execution. Supported Bash/zsh
shells receive private startup wrappers; other shells start normally. Preparation
failure also starts an ordinary shell, without retrying a process launch. A
pending integration becomes unavailable after ten seconds without a valid event;
a late successful initialization can still activate tracking. Typing is never
blocked by that state. Untracked shells do not show a guessed running indicator.

The Terminal options menu offers **New terminal without command tracking** on
engines advertising the optional capability. The existing shell is retained;
the new one uses the same task-owned PTY lifecycle without injected hooks. Set
`ELEVENEX_TERMINAL_SHELL_INTEGRATION=0` in the backend environment to disable
injection for new shells globally, or in the user's rc to opt out of hooks for
that shell. Existing engines and callers retain their default contracts.

Bash/zsh adapters emit bounded, authenticated OSC status/command frames. The
random per-process token lives in private temporary files and is not exported to
children. This distinguishes ordinary untrusted output; it is not isolation from
hostile programs with same-user filesystem/process access. Bash preserves string/
array prompt hooks, incoming exit status and existing DEBUG traps. Zsh preserves
`.zshenv`, redirected `ZDOTDIR`, `.zshrc` and intentional suppression of rc
files. Both integrated shells enter the resolved task workspace after their rc;
plain shells use the normal PTY cwd and unmodified shell initialization.

Zsh reports the actual submitted command through preexec, so history recall and
cursor editing work without reconstructing keystrokes. Bash reports a completed
command only when a fresh history entry identifies it; ignored commands, disabled
history and ambiguous entries disable rerun. History settings and locations are
preserved. Modern Bash uses PS0 for start events; older Bash installs a start-only
DEBUG hook only when no user trap or inherited-debug mode would be displaced.
Completion/status still work when that hook cannot be installed.

The backend never records input as command text or examines passwords/foreground
program input. Any new prompt input invalidates rerun until the shell reports a
new command. When a command receives further input or submission includes
type-ahead, rerun also remains disabled: that input may still be queued at a
future prompt. Single-line shell reports are bounded to 4 KiB, escaped, decoded
and validated before they can become a rerun. Multiline/control-containing commands
and malformed reports use a generic label with rerun disabled. Scripts rerun by
their rediscovered ID. Reads and reconnect never execute commands. The failure
bar uses Fold; ViewTabs retains its existing motion, and initial history stays
still. Failed processes retain output until close.

Ask the agent adds the command, exit code and last 80 rendered lines (8,000
characters) to the selected conversation's existing composer draft. Existing
writing is preserved. It restores chat focus and never sends a prompt. Archived
conversations cannot receive this action.

A recognized localhost HTTP(S) serving port produces `TerminalBrowserIntent`
with scope/task/terminal/port, never an output URL. The workspace selects Browser;
main rechecks the live terminal and opens its service in the system browser.
For SSH, it creates/reuses this window's managed forward and uses its actual
bound local port. Pending handoffs track the selected service: a second explicit
opening can proceed, and earlier replies cannot overwrite its busy/error state.
The small Browser service handoff is the standalone fallback;
a richer Browser owner can consume the same typed intent without changing the
terminal domain. Detection never itself navigates. Saved forwards retain their existing window-manager lifetime; closing a terminal
does not remove a saved forward.
