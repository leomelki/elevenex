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
Selecting a terminal tab focuses its attached xterm input, including cached surfaces.
Metadata and output updates preserve the current focus.
Observers belong to the visible attachment. Hidden panels are inert and detach their output subscription; reconnect and show reattach by task/terminal/generation/offset.
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

Each process owns a random generation and a bounded 256 Ki-unit indexed output
window. New engines advertise `streamVersion: 1`. `TerminalStreamAttachment` owns
one visible attachment's typed IPC subscription, ordered writes, cursor commits
and render credits. Main owns its WebSocket and private endpoint lease; scope,
window/document changes and detach close it. No socket or credential reaches
Angular. Output bypasses Signals; metadata updates only the relevant controls.
The metadata store stops its HTTP loop when streaming is supported. Ordinary
older engines retain the HTTP output adapter and its bounded pages.

Visible attachments are keyed by machine, backend scope, task, terminal,
generation, protocol and connection availability, plus the DOM host. Metadata,
output cursors, titles and command state update the existing entry without
detaching its surface or releasing input ownership. Lifetime reconciliation runs
untracked so reads/writes of metadata and seen cursors cannot feed back into
attachment teardown. A stream interruption retains the DOM, waits for pending
output to settle and schedules one owned backoff; hiding or replacing the view
cancels it. Development-console attachment counters distinguish lifetime changes
from stream retries without logging PTY content or input.

Input is pipelined over the stream without a remote round trip per chunk. Text
and binary mouse input share one bounded, ordered queue. No input is retried.
Unknown outcomes clear pending data and require explicit **Resume typing**;
this also applies when hiding a view with unacknowledged input. Reconnect uses a
new attachment and input sequence, and only resumes confirmed output. One focused
view owns input/resize when several windows display the same PTY.

The backend worker retains confirmed screen state independently of the view and
answers terminal queries even while hidden. Cursor recovery uses incremental
history when available, otherwise a bounded serialized checkpoint plus subsequent
output. Snapshot application disables input/replies; live views suppress queries
already answered by the server. The public serializer and incomplete-sequence
suffix preserve supported terminal state across reattachment. See the
[stream architecture, security, flow control and budgets](../../../../backend/src/user-terminal/stream/README.md).

Resize is fit-to-container, frame-coalesced and single-flight. Predictions roll
back and finish drawing before resize/reflow. Output carries its producing grid;
historical resizes never reach the PTY. Initial creation supplies font-measured
geometry when available. Windows replies carry validated ConPTY metadata.
Visible and headless emulators both use the official Unicode 11 addon.

`TerminalLocalEcho` maintains a bounded reversible prediction timeline through
xterm's renderer. There is no DOM text overlay. The public serialization addon
saves the affected row and current drawing attributes, which are restored before
real output in the same xterm write. Matching screen/cursor states retire edits;
mismatches roll back and wait for a fresh authenticated prompt. Empty output and
input acknowledgements cannot confirm speculative characters.

Auto prediction requires a confirmed echo in the current prompt, at least four
samples, 80% accuracy and median echo latency of at least 30 ms. It supports
single-row ASCII insertion/deletion, backspace, CSI/SS3 arrows, Home/End and common
line/word deletion keys. Enter, history/completion keys, bracketed paste, IME,
Unicode widths, wrapping and alternate/mouse-tracking applications retain normal
server echo. These limitations affect prediction, not terminal input support.
Pending prediction expires after five seconds or 256 edits and stops on detach,
scrolling away, resize, transport failure or disabled input. New prompt grants
must not race with queued/unacknowledged input or later user edits.

Copy and search follow visible text, including tentative characters. **Ask the
agent** uses only bounded confirmed backend context (80 lines/8,000 characters);
older engines roll back predictions before collecting local context. No prompt
is sent automatically. Prediction can be switched between **Auto** and **Off**.

**Terminal settings** stores the user's default/custom shell profile per machine
in a private, atomic file under desktop application data. Executable, literal
argument arrays, environment overrides/removals and POSIX login mode apply to new
shells. Shells use explicit argument arrays in the resolved task directory.
Profiles with startup arguments/login mode bypass injected hooks so the user's
initialization wins; ordinary supported shells retain optional integration.
Engine capability variables are not inherited by desktop shells. Settings do not
mutate existing PTYs or write into task checkouts. Script discovery still reads
one confined root manifest (256 KiB/100 scripts), with its bounded cache.

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
Terminal-specific type tokens use 11.5px text with a 17.25px target line height
(xterm line-height ratio 1.5), independently of code blocks and diffs.
A bundled symbols-only Nerd Font fallback covers Powerline, Git, Node.js and other
private-use prompt icons; it and the regular/bold text faces load before cell
measurement and leave ordinary text in Geist Mono. See the
[font provenance and licenses](../../../public/fonts/README.md).

Tab labels use the optional backend `activityTitle`, falling back to the saved
`title`; detected ports retain their existing suffix. During a tracked command,
the backend derives a conservative literal executable name without arguments.
A program's standard OSC 0/2 title can override that label for the current command.
Completion restores the shell name even after failure; process exit clears activity.
An unsupported command head keeps the saved name rather than guessing a shell
expression. This is command/title tracking, not OS foreground-process discovery.

Saved names differing from the default shell basename and project-script names
take priority; automatic titles never rename database records. Plain/untracked
shells may supply standard OSC titles independently of integration. Titles are
bounded, normalized display text: they cannot authorize command tracking, rerun,
service detection or navigation. Main validates the additive field. Titles follow
the existing scoped metadata reads for local and SSH backends, without new timers,
process-table scans, IPC channels or renderer networking. Changing a title preserves
the keyed tab, selection, focus, terminal surface and process generation. Older
engines omitting the field retain their existing labels.

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

Bash/zsh, fish and PowerShell adapters emit bounded, authenticated OSC status/command frames. The
random per-process token lives in private temporary files and is not exported to
children. This distinguishes ordinary untrusted output; it is not isolation from
hostile programs with same-user filesystem/process access. Bash preserves string/
array prompt hooks, incoming exit status and existing DEBUG traps. Zsh preserves
`.zshenv`, redirected `ZDOTDIR`, `.zshrc` and intentional suppression of rc
files. Integrated Bash/zsh shells enter the resolved task workspace after their rc;
plain shells use the normal PTY cwd and unmodified shell initialization.

Zsh reports the actual submitted command through preexec, so history recall and
cursor editing work without reconstructing keystrokes. Fish uses native events;
PowerShell wraps the existing console readline/prompt functions after profiles.
Execution policy and restricted language mode remain in force. PowerShell reports
pipeline success as 0/1. Bash accepts a command only when a fresh history entry identifies it; ignored commands, disabled
history and ambiguous entries disable rerun. History settings and locations are
preserved. Modern Bash uses PS0 for start events; older Bash installs a start-only
DEBUG hook only when no user trap or inherited-debug mode would be displaced.
Completion/status still work when that hook cannot be installed.

The backend never records input as command text or examines passwords/foreground
program input. Any new prompt input invalidates rerun until the shell reports a
new command. When a command receives further input or submission includes
type-ahead, rerun also remains disabled: that input may still be queued at a
future prompt. Single-line shell reports are bounded to 4 KiB, escaped, decoded
and validated before they can become a rerun. Multiline commands can be retained
as bounded display metadata; the failure label
remains generic and rerun stays disabled. Control-containing and malformed reports
are rejected. The optional `currentCwd` updates the tab's directory details after
`cd`, while `cwd` retains the launch workspace for older consumers.

Command/Ctrl-Up/Down navigates authenticated command-output starts. xterm markers
follow resize/reflow, are bounded to 200, and are disposed on output gaps/reset,
scrollback expiration and surface cleanup. Navigation never sends PTY input and
leaves alternate-screen applications in charge of their keys. Old engines and
plain terminals retain ordinary keyboard behavior without markers.

The optional `commandTracking` capability enables `taskTerminalCommands` reads:
20 immutable completions per generation/after-ID page plus one current record,
with bounded command text, confidence, cwd, exit state, timestamps and duration.
History is separate from output replay; missing hooks have null timing. A history
picker is not part of this slice. Scripts rerun by their rediscovered ID. Reads and reconnect never execute commands. The failure
bar uses Fold; ViewTabs retains its existing motion, and initial history stays
still. Failed processes retain output until close.

Ask the agent adds the command, exit code and last 80 confirmed lines (8,000
characters) to the selected conversation's existing composer draft. Existing
writing is preserved. It restores chat focus and never sends a prompt. Archived
conversations cannot receive this action.

A discovered process-owned TCP listening port produces `TerminalBrowserIntent`
with scope/task/terminal/port, never an output URL. The workspace keeps Terminal
visible; main rechecks the live terminal and opens its service in the desktop's
system browser. This is independent of the embedded Browser feature. The optional
`url` in the successful reply is the actual desktop-local address, including the
managed forward's bound port for SSH services. `TaskTerminal.browserState`
accepts readonly terminal ID, busy/error and URL feedback from its owner. Feedback
is shown only for the matching task and active terminal; the address can be
selected and copied for manual testing. Older replies without a URL remain valid.
Discovery reads actual listeners belonging to the PTY and its descendants,
including silent servers and background jobs. Printed URLs only refine the
protocol and a confined pathname of a confirmed listener; they cannot create a
serving badge. ANSI styling and OSC metadata do not affect discovery, and original
PTY output remains unchanged. The primary port remains stable when possible;
additive metadata carries up to 16 services. Closed ports disappear on the next
metadata refresh, and opening rechecks ownership/generation with a fresh scan.
Collector failure clears advertised ports while leaving the shell usable.
See [discovery architecture, platform support and limits](../../../../backend/src/user-terminal/ports/README.md).
For SSH, it creates/reuses this window's managed forward and uses its actual
bound local port. Automatic terminal forwards use a desktop-persisted assignment
in 20000–29999 keyed by saved server, exact loopback target and remote port. The
URL survives reconnects and app/service restarts at that endpoint; established
port conflicts are reported without silently choosing another port. Windows
share listeners through independent leases. Explicit local-port forwards retain
their existing behavior. See [allocation and persistence](../../../../desktop/REMOTE_DEVELOPMENT.md).
Pending handoffs track the selected service: a second explicit
opening can proceed, and earlier replies cannot overwrite its busy/error state.
The small Browser service handoff is the standalone fallback;
a richer Browser owner can consume the same typed intent without changing the
terminal domain. Detection never itself navigates. Saved forwards retain their existing window-manager lifetime; closing a terminal
does not remove a saved forward.
