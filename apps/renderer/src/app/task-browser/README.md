# Production task browser

`TaskBrowserComponent` integrates `BrowserView` through the existing
`WorkspacePanels` browser slot. Its lifetime follows **project → task**, independently
of the selected conversation. Questions and error reports capture scope/task/session
and stage context in that session's explicit composer. They never send prompts.

Opening an empty browser creates one user-owned start tab. The + button and
Command/Ctrl-T create the same tab immediately and focus its address bar; Enter
navigates that tab. The trusted start page also offers discovered task servers.
No website, guest or remote Chromium process starts until navigation. Existing
tabs survive panel/conversation changes. Closing the last tab leaves the New tab
action available; returning to the empty browser creates its default again.

## Rendering and composition

Browser Tools selects **This device**, **This device · task proxy**, or
**Stream from task machine** through the scope-bound configuration operation.
Close tabs with loaded pages before switching; profiles are separate. The proxy
forwards task localhost servers while public traffic stays on this device. Local
tasks default to this device; remote tasks default to the task-machine stream.
See [the architecture review and extension boundaries](../../../../../docs/task-browser-architecture.md).

Desktop-hosted tasks use a real Electron guest `<webview>`. `EmbeddedPageComponent` creates
only the fixed element; main issues its ephemeral partition and bootstrap identity,
validates `will-attach-webview`, forces hardened preferences, and adopts the exact
contents through `taskBrowserAttach`. There is no page preload, Node, app bridge,
nested guest, arbitrary renderer webPreferences, or renderer network permission.
This guest mode is an explicit product choice; the app CSP remains restrictive.

The guest stays in a stable DOM slot, so normal app DOM menus, dialogs, picker
rectangles and agent targets compose above it. No native child view covers app
controls. `NativePageLayout` measures visual placement and the separate logical
CSS viewport: modal recession scales the page without making the site responsive
again. `BrowserSurfacesComponent` converts window bounds into the containing
panel's transformed coordinates. Phone width, app zoom, expansion and interrupted
motion use the existing shell/Fold motions. Inactive guests remain mounted offscreen,
inert and without input; hidden panels also stop page audio and frame production.

A remote backend hosts real sandboxed Chromium. Main owns its private transport,
viewer lease and credentials; the renderer receives only typed state and bounded
JPEG display frames. Remote pages always use `BrowserStreamComponent`. Local
Tools also offer a compatibility Stream display using the same guest engine.
The streamed display has one decoding frame and one latest replacement. Explicit
acks, adaptive resolution/quality and host backpressure avoid growing a frame queue
on slow links. A typed, bounded input lane coalesces motion/scroll, preserves key
and text order, and drops queued work on hidden/disconnected/changed authority.
IME, Unicode, editing and clipboard use narrowly typed human-only adapters.
Neither pixels nor input are persisted or logged.

## Driver ownership and privacy

Each tab has one authoritative driver and a monotonic generation. User-created
tabs start with the user; agent-created tabs remember their session. Hand back is
explicit and backend-authorized against that task/session. Agents cannot select
over a user's active tab, type into private controls, or close user-created tabs.
Native `before-input-event`/`before-mouse-event`, or the remote host's first human
input, revokes agent authority before accepting interaction. Every awaited action
rechecks its generation, task, visibility, viewport and navigation. Menus, motion,
layout changes, task switches, crashes and disconnects invalidate stale work.
An uncertain action is never retried or replayed automatically.

Agent steps/targets are trusted app overlays in **page CSS coordinates**. They do
not grant authority and are cleared when their coordinate generation changes.
The MCP `task_browser` tool offers bounded list/open/select/close/navigate/back/
reload/click/scroll/needs-user operations, not arbitrary JS, CDP, text entry,
filesystem, snapshots or screenshots. Agent replies are independently allowlisted
on the backend. The local at-most-once mailbox permits 64 desktop leases and 16
pending requests per lease; the remote engine permits eight requests per task
and one observation/action per tab. Remote viewer reconnects rotate the lease,
return control to the user and abort previous automation generations.

Complete secret redaction cannot be established for arbitrary DOM, accessibility,
canvas, frames, closed shadow roots, console strings or screenshots. **All those
agent-readable channels are withheld** on every page. There is no advertised
masking. Only bounded error counts and structural geometry are shared. Chromium
or Playwright debug logging that could expose private page data fails closed.
Sign-in/2FA/payment fields hand control to the user. Popups, dialogs and unsupported
site flows have explicit attention messages and Open outside, which uses a
separate browser profile rather than promising transferred sign-in state.

The real picker consumes page input, resolves a structural `nth-child` selector,
tag and rectangle at viewport CSS coordinates, and excludes editable controls,
embedded frames and open shadow hosts. Closed roots remain opaque. App zoom, scrolling and responsive layout are
accounted for. Text, attributes, source locations and element screenshots are
unavailable; the question sheet states that limit. Sending stages the geometric
context in the selected session's composer for review.

Errors retain counts only, capped at 999. **Send to agent** is an explicit composer
intent. The optional “Share error counts during agent work” setting exposes those
counts only while that session owns the tab; it never injects autonomous prompts.

## Resources, storage and navigation

Each window retains at most four tasks and each task twelve tabs. A task's tabs
share one ephemeral profile for cookies, localStorage, IndexedDB and normal web
APIs; other tasks/windows/launches are isolated. Closing a tab destroys its page;
evicting the task destroys the profile and closes its network resources. Switching
conversations or panels retains live history, forms and scroll. Returning to a
retained task preserves its live page but reconnects with user control.

Bounded metadata stores only committed HTTP(S) locations (without query/fragment),
selection, width and creator provenance. Failed navigations and download attempts
are never restored as documents. Reopening after destruction restores lazy tabs
with user control, not actions or credentials. Task/repository identity and actual
SSH configuration distinguish recreated tasks/edited destinations.

The task-owned SOCKS connector preserves logical origins, TLS, CORS and WebSockets.
Explicitly opening a task port grants its connection; stdout port discovery is a
suggestion, never network authority. Unknown loopback, private LAN/rebinding and
application control destinations are blocked. Remote display browsers access their
host's task server, never desktop localhost. Open outside acquires an owned SSH
forward where necessary. Permissions and client certificates are denied; TLS
validation, browser sandbox and web security stay enabled. Self-signed development
servers need a valid trust setup.

Main and host own debugger attachments, contexts, sockets, installer processes,
observation listeners and timers. Frame payloads cap at 3 MB; decoding also checks
JPEG dimensions before allocating. History caps at 100 entries. Layouts carry a
presentation epoch and monotonic sequence; a 750 ms heartbeat makes hidden or
unresponsive app surfaces noninteractive. Remote viewers have exclusive leases,
a ten-second heartbeat expiry and five-minute idle context retention. A competing
viewer gets a visible conflict and explicit Reconnect, never silent takeover.

## Capabilities and extension boundaries

Theme and slow-network tools use private, fixed CDP commands, with no CDP bridge.
Local guests support native accessibility, audio, file inputs and user-initiated
OS downloads (two concurrent, 32 MB each); agent downloads require the user.
The first remote JPEG mode does **not** relay audio, page accessibility, device
permission prompts, file picking or downloads. Tools explain those limits and
provide Open outside. Unsupported controls do not silently succeed. No web/mobile
client ships in this foundation; remote desktops use the same private runtime
protocol. A future web/phone client can implement the presentation/transport
adapter behind an authenticated gateway without changing the task/driver contract or exposing generic HTTP/CDP.

The workflow footer keeps one DOM/geometry identity when user input takes over.
Its progress row reserves height even before a total is known; existing error
counts stay visible in the workflow controls during agent work. Ownership changes therefore do not move
the page between mouse-down and mouse-up. Native pages can finish an already
accepted human release during visible chrome motion; hidden pages remain gated.

Human input queues cap at 128 events. Up to 32 ordered events and 65,536 text
code units travel per batch, reducing typing round trips without dropping browser
key events. Clipboard commands travel separately, preserving copy/paste order.
Navigation, authority changes and unknown outcomes discard queued work. Following
uncertain delivery, fresh state alone does not resume typing: the user must click
the page or explicitly Focus page. Failed batches are never replayed.

A crashed/disconnected remote engine requires explicit Reload. The task preserves
safe locations/provenance, revokes old ownership, replaces its closed context/page
and returns user control. A failed old agent launch cannot destroy a tab the user
has taken over. Pending picker/clipboard observations check navigation and owner
again before applying their result; private picker targets produce visible feedback.

Popup/dialog notices retain their originating tab ID. Open outside uses that
captured resource even after selecting another tab; closing it clears the notice.
Completed downloads similarly retain their initiating page identity and never
publish OS save paths. Unowned popups are closed without suggesting an unrelated
tab as the destination.

## Detached tab windows

`TaskBrowserComponent.windowContext` supplies bounded project/task/branch/machine
labels, stage and hue. With the optional bridge capability, **Open tab in new
window** opens the selected tab through named, scope-bound IPC. `BrowserWindowComponent`
is the dedicated lazy `/browser-window` route. Its `Project / Task` title-bar
control reveals the owning task using a bounded navigation window; the centered
machine island remains on wide windows, and Return tab is one icon. Task labels
are presentation data, never resource authority. `/browser-window` in the isolated
component preview exercises the same component with a preview-only provider.

Each companion is bound in main to one source window, backend scope, task and
existing tab. No IDs from route parameters establish ownership. It can neither
create nor control sibling tabs. The panel retains its tab and offers Show window
and Return tab. Native close returns the tab; explicit Return also reveals its
task. Other tabs remain usable. Missing/closed tasks and changed source scopes
leave an inert Task unavailable surface instead of silently closing the window.
At most twelve companions are open, and their tasks are pinned against eviction.

**Local moves reload the page**, retaining the same tab ID and ephemeral task
profile (including sign-in). Electron cannot adopt an already attached guest in
another renderer. Rehosting never reads or copies forms/page text/storage into
application state. Unsubmitted forms, scroll and live document state do not carry
across. Both documents use hardened, main-issued native guests. Returning also
reloads; it invalidates prior input generations and restores user control.
Remote companions share the existing private viewer lease and live task pages,
with separate bounded viewport, frame receipt and input state per tab. Hidden
source panels do not disconnect a visible companion.

Guest cleanup captures the webContents reference before native close; accessing
`window.webContents` after `closed` can throw. Companion listeners, pending guests,
frames and scope subscriptions are released by their creators. Entry and explicit
return use token durations and reduced-motion handling; page input waits for
stable geometry. The detached production route is covered by
`apps/desktop/test/browser-detached-native.cjs` within the Electron smoke.
