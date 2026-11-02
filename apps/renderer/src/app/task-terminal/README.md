# Production task terminals

`TaskTerminalComponent` adapts the existing `TerminalView` / `ViewTabs`. The
workspace projects it through `WorkspacePanels[workspaceTerminal]`; task identity
is independent of the selected conversation. Terminal data and surfaces activate lazily on first
use. Opening Terminal checks the current task's backend list and starts one shell
if it is empty. Existing tabs (including exited shells) are retained. Each opening
attempts startup once; polling and reconnect never retry it. Hiding or switching
tasks cancels a pending opening before startup. New shell, script launch, interrupt,
rerun and process close remain user actions. There are no agent terminal tools or
chat-output mirrors. Existing agent approval flows are unchanged.

`lastClosed` asks the workspace to close its side panel after the last terminal's
close has settled successfully. Failed/uncertain closes remain inspectable, and
late closes cannot hide another task or panel. Reopening an empty Terminal starts
a fresh shell; hiding a panel with existing shells only detaches them.

The metadata store owns scoped reads and four task snapshots. The component owns
up to eight xterm surfaces, each with 2,000 scrollback rows, selection, reading
position and a bounded input queue. Eviction disposes a surface, never its PTY.
Observers belong to the visible attachment. Hidden panels are inert and stop
output reads; reconnect and show reattach by task/terminal/generation/offset.
Session changes within a task keep the same surface and process. Switching
machines clears display caches. Window closure detaches; app-owned local engine
shutdown stops PTYs. Remote daemon processes remain until explicit close, task
finish, or daemon shutdown. Task finishing uses the existing strict PTY cleanup.

Closing removes a tab and selects its neighbour immediately while backend process
cleanup continues. Other tabs and actions remain available. Pending closes are
excluded from metadata refreshes, including after task switches. Completion
reconciles the backend list without replaying close; failed or uncertain closes
restore any surviving tab and show an error without replacing the current selection.

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
it. Generation changes reset the surface and are labelled. Engine restart, or an explicit replacement through a legacy client, leaves
old desktop terminal history unavailable: neither reads nor reconnect start shells.
One active output read runs at a time; metadata refresh is bounded to 16 tabs.
Script discovery reads one confined root package manifest (256 KiB, 100 scripts),
coalesced/cached for three seconds. Launch and rerun rediscover it.

Input dispatch is serialized, capped at 128 KiB per pending paste and split into
small Unicode-safe requests. Oversize pastes are refused visibly. Input is never
retried. Unknown input outcomes clear pending data, disable typing and require
an explicit Resume typing after inspection. New connection generations invalidate
pending input. Resize is fit-to-container, frame-coalesced and single-flight.

ANSI is rendered by the installed xterm 6 adapter, loaded lazily. OSC 52 clipboard
access and OSC 8 navigation are disabled. A window-owned style lease nonces generated sheets and adapts only the DOM
renderer's finite RGB/underline declarations to CSSOM. xterm 6.0 otherwise uses
CSP-blocked style attributes for truecolor and selections. Arbitrary CSS, raw HTML
and non-span attributes keep the browser's normal CSP path. Leases restore the
DOM factory after the last surface closes; production CSP is unchanged. Native user selection/copy and paste
remain available. Find searches at most the retained 2,000 rows / 1,000 matches;
Enter/Shift-Enter moves between matches, Escape restores focus. The theme maps
the specification's ANSI palette to authoritative tokens and local Geist Mono.
A bundled symbols-only Nerd Font fallback covers Powerline, Git, Node.js and other
private-use prompt icons; it loads before cell measurement and leaves ordinary
text in Geist Mono. See the [font provenance and licenses](../../../public/fonts/README.md).

Bash/zsh prompt hooks report command start/completion and exit status. They source
the normal user rc then explicitly enter the resolved task worktree. Other shells
remain interactive; per-command status requires their prompt integration. Rerun
uses only a discovered script ID or a reliably captured plain user input line,
never a command extracted from output. Foreground-program input, including hidden
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
