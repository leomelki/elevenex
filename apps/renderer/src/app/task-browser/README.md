# Production task browser

`TaskBrowserComponent` integrates `BrowserView` through the existing
`WorkspacePanels` browser slot. Its lifetime follows **project → task**, independently
of the selected conversation. Questions and error reports capture scope/task/session
and stage context in that session's explicit composer. They never send prompts.

Opening an empty browser creates one user-owned start tab. The + button and
Command/Ctrl-T create the same tab immediately and focus its address bar; Enter
navigates that tab and removes focus from the address bar. An empty address keeps
focus for typing. The trusted start page also offers discovered task servers.
No website, guest or remote Chromium process starts until navigation. Existing
tabs survive panel/conversation changes. Closing the last tab leaves the New tab
action available; returning to the empty browser creates its default again.

Tab labels follow the page title, including live title changes, in both local and
streamed browsers. Titles are normalized and bounded to 200 characters, with the
location as fallback and “New tab” for an empty tab. They are human-facing only:
navigation persistence and MCP replies do not include page titles.

## Rendering and composition

Browser Tools selects **Local**, **Local · task proxy**, or **Remote** through
the scope-bound configuration operation. Main supplies the available locations;
local tasks offer only Local. There is no separate display-mode choice: local
engines embed natively and remote engines stream from the task machine.
Close tabs with loaded pages before switching; profiles are separate. The proxy
forwards task localhost servers while public traffic stays on this device. Local
tasks default to Local; remote tasks default to Remote.
See [the architecture review and extension boundaries](../../../../../docs/task-browser-architecture.md).

Desktop-hosted tasks use a real Electron guest `<webview>`. `EmbeddedPageComponent` creates
only the fixed element; main issues its task profile partition and bootstrap identity,
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
H.264 access units (JPEG on older hosts or codec failure). Remote pages always use `BrowserStreamComponent`. The
legacy local stream IPC remains compatible but is not exposed in Browser Tools.
The streamed display has one decoding frame and a bounded video delivery window. Explicit
acks, adaptive resolution/quality and host backpressure avoid growing a frame queue
on slow links. A typed, bounded input lane coalesces motion/scroll, preserves key
and text order, and drops queued work on hidden/disconnected/changed authority.
IME, Unicode, editing and clipboard use narrowly typed human-only adapters.
Neither pixels nor input are persisted or logged.

`BrowserHumanInput` owns DOM gestures and composition; `BrowserInputLane` owns
bounded delivery and authority. Composition updates coalesce until their commit,
AltGr/Option characters retain native text entry, and undo/redo use editing intents.
Pointer capture cancellation and focus loss release held input. Motion coalescing
preserves button/modifier changes; wheel coalescing preserves the target and modifiers.
The host owns a separate page input lane and cancels/releases held gestures when
the presentation hides, resizes, navigates or hands control away. Blink editing
commands keep undo/redo/select-all independent of the remote host's operating system.

The display reuses its canvas backing store until dimensions change. Task changes
and hidden presentations clear old pixels; asynchronous JPEG/video output cannot
paint into a replacement task. Frame receipts retain the originating task identity.
Decoder support checks, output callbacks and errors are guarded by decoder lifetime.
These changes keep the existing wire contract, including older JPEG/HTTP hosts.

`scenarios/browser-stream.mjs` exercises the production stream component in the
`/browser-video` preview with actual Chromium pixels, managed FFmpeg H.264, trusted
keyboard/IME input, both themes, a narrow reduced-motion view and display pause.
It uses an isolated preview bridge; it does not establish external SSH behavior.

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
and one observation/action per tab. Remote viewer reconnects rotate the viewer lease
and preserve task execution and current agent control. Reconnect never replays input.

Complete secret redaction cannot be established for arbitrary DOM, accessibility,
canvas, frames, closed shadow roots, console strings or screenshots. **All those
agent-readable channels are withheld** on every page. There is no advertised
masking. Only bounded error counts and structural geometry are shared. Chromium
or Playwright debug logging that could expose private page data fails closed.
Sign-in/2FA/payment fields hand control to the user. Machine hosts advertising
`workflows: true` adopt popup pages into the same task context, retaining cookies,
`window.opener`, `postMessage` and site-driven close for OAuth. A popup from the
active page selects its new tab; background popups do not replace another selected
tab. Closing a selected popup returns to its surviving opener. The twelve-tab cap
and network policy still apply. Local native popup behavior remains unchanged.
Unsupported site flows retain Open outside, which uses a separate browser profile.

The real picker consumes page input, resolves a structural `nth-child` selector,
tag and rectangle at viewport CSS coordinates, and excludes editable controls,
embedded frames and open shadow hosts. Closed roots remain opaque. App zoom, scrolling and responsive layout are
accounted for. Text, attributes and element screenshots remain unavailable.
An explicit human pick also resolves React development source metadata through
the shared [browser inspection runtime](../../../../../packages/browser-inspection/README.md):
React 18 debug source and React 19 debug stacks with bounded same-origin source
maps. Agent clicks do not run source detection. The optional, page-reported
file/line/column is displayed in the card and staged in the selected conversation's
composer only on request; it never grants file access. Missing/unsupported metadata
keeps the selector-and-position fallback, and `askNote` states what is available.
The card names the
element by its tag; the staged question carries the full selector. Main pauses
(hides) the page after a pick, so the trusted preview slot shows a dotted
"Page paused while you ask" ground under the ring and card. Main does not inspect
on hover, so production omits `hovered`. Sending stages the geometric
context in the selected session's composer for review.

Errors retain counts only, capped at 999. **Send to agent** is an explicit composer
intent. The optional “Share error counts during agent work” setting exposes those
counts only while that session owns the tab; it never injects autonomous prompts.

## Resources, storage and navigation

Each window retains at most four tasks and each task twelve tabs. A task's tabs
share one persistent Chromium profile for cookies, localStorage, IndexedDB,
service workers, cache storage and normal web APIs. Profiles are isolated by
backend destination, task incarnation and browser location, and survive task
eviction, conversation changes and app restarts. Local profiles live in Electron's
private application data; task-machine profiles live in that backend's application
data. Closing a tab destroys its page; eviction closes pages and network resources
without clearing site data. A local profile has one owning app window at a time,
so another window cannot replace its task network policy. Switching
conversations or panels retains live history, forms and scroll. Returning to a
retained remote task preserves its live page and current agent ownership. Navigation
keeps the existing page visible while Chromium loads the next document; loading
status stays in browser chrome rather than replacing the page.

Bounded metadata stores only committed HTTP(S) locations (without query/fragment),
selection, width and creator provenance. Failed navigations and download attempts
are never restored as documents. Reopening after destruction restores lazy tabs
with user control and the same site profile; queued actions never resume. Task/repository identity and actual
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
a thirty-second heartbeat expiry independent of retained task execution. A competing
viewer gets a visible conflict and explicit Reconnect, never silent takeover.

Explicit Reload after a crashed or closed local engine retains the tab ID, order,
width, theme, network setting and companion placement. Main issues a fresh blank
guest identity for the replacement engine; the renderer replaces that guest while
keeping the tab stable. Ordinary site navigation and layout updates retain the
existing guest. Closing a companion tab destroys its engine directly, and closing
a restored active tab starts the next lazy page. Picker exit clears native input
interception together with the visible picker state.

Location changes prepare the target before replacing the current host, then
recheck task selection, tab identities, control generations and loaded/pending
pages. A concurrent user action cancels the replacement. Companions pin their
task owners; when all four retained task slots are pinned, opening another task
browser reports capacity instead of silently exceeding the bound.

## Capabilities and extension boundaries

Hosts advertising `webAuthn: true` can relay explicit WebAuthn registration and
sign-in to the viewing device. A main-owned sheet (`PasskeyAsk`) names the
requesting origin and asks first;
ceremony options/results stay in main and the private viewer transport. No
renderer control or credential access is added. See [WebAuthn architecture and
native authenticator limits](../../../../../docs/task-browser-webauthn.md), including
unsupported security-key PIN entry and arbitrary macOS synced passkeys.

Theme and slow-network tools use private, fixed CDP commands, with no CDP bridge.
Local guests support native accessibility, audio, file inputs and user-initiated
OS downloads (two concurrent, 32 MB each); agent downloads require the user.
The remote display does **not** relay audio, page accessibility or device
permission prompts. On capable hosts, site requests appear above the page:
alert/confirm/prompt/beforeunload dialogs require a human response; prompt drafts
remain local until confirmation. `BrowserSiteRequestsComponent` renders the
request bar and the `SiteDialog` design (see
`docs/design-system/project/components/SiteDialog/README.md`). It names the
asking site from the tab's `pageUrl` because runtime dialogs carry no frame
origin, so a cross-origin iframe's dialog shows the tab's site. Leave prompts
show fixed copy instead of site text. Uploads use the desktop's native file picker
and downloads require its native Save dialog. No renderer filesystem paths or
file bytes enter IPC or agent observations. Older hosts omit the capability and
retain the update/Open outside explanation.

Transfers use the viewer-authenticated private HTTP transport, with 48 KiB
chunks, at most sixteen files per upload, a 32 MiB total task upload budget,
two concurrent uploads, and two retained downloads of at most 32 MiB each.
Chromium download progress cancels oversized/slow responses. Pending site requests
expire after five minutes. Navigation invalidates dialogs/choosers; completed
files may still be saved after navigation. Viewer loss, engine failure, tab/task
closure and explicit cancellation release requests and temporary files. Transfers
are never resumed or replayed after disconnect. Saves write a sibling temporary
file and replace the chosen destination only after all bytes are validated.

Stream surfaces carry an allowlisted CSS cursor keyword, with custom cursor images
reduced to their keyword fallback. Hosts advertising `pointerLock: true` publish
page lock state. The user explicitly clicks **Use pointer lock** to grant the
viewing canvas relative motion; Escape releases both ends. Main permits this only
for a trusted app main frame with a visible, interactive, human-owned locked stream.
Hidden pages, navigation, handoff, focus loss and disposal release the lock.
When a surface includes `pointerLockEpoch`, local consent and relative motion
are bound to that host acquisition plus the displayed task/document/control
identity. A changed identity releases local lock and discards queued old motion;
an old unlock cannot release a newer host acquisition. Task switches never route
the former task's unlock through the new surface. Legacy surfaces omit the epoch
and retain their original input shape. Consecutive relative deltas sum only
within the same epoch, buttons and modifiers. One reserved cleanup request lets
Escape reach the host even when all ordinary input credits await receipts.
Late receipts for released motion cannot interrupt a fresh acquisition; a new
explicit **Use pointer lock** gesture can resume interrupted input without replay.
The host observes real Chromium lock state in isolated frame contexts and checks
the owner with bounded reconciliation outside ordered input. A stalled receiving
page may still delay native delivery or cause its lock to expire; see the
[host ownership and ordering contract](../../../../backend/src/desktop-browser/README.md#pointer-lock-ownership-and-input-ordering).
Unsupported controls do not silently succeed. No web/mobile
client ships in this foundation; remote desktops use the same private runtime
protocol. A future web/phone client can implement the presentation/transport
adapter behind an authenticated gateway without changing the task/driver contract or exposing generic HTTP/CDP.

The workflow footer keeps one DOM/geometry identity when user input takes over.
Its progress row reserves height even before a total is known; existing error
counts stay visible in the workflow controls during agent work. Ownership changes therefore do not move
the page between mouse-down and mouse-up. Native pages can finish an already
accepted human release during visible chrome motion; hidden pages remain gated.

Human input queues cap at 512 unsent events / 65,536 queued text code units.
The larger event budget retains fast typing during a long receipt stall; normal
focus on an already healthy page preserves queued writing. Input does not wait
for fresh video on a stable document and viewport. Up to 32 ordered events and
65,536 text code units travel per batch, reducing typing round trips without dropping browser
key events. Hosts advertising `inputWindow: 4` serialize complete batches and
allow four outstanding writes to absorb network jitter; older hosts retain one.
Compatible single relative moves may overlap native receipts; other input and
complete batches remain ordered barriers.
Clipboard commands travel separately as barriers, preserving copy/paste order.
Queue pressure or uncertain delivery requests held-state cleanup on capable
hosts. Typing stays stopped until fresh interaction; cleanup never replays input.
Document replacement, authority changes and unknown outcomes discard queued work.
Following uncertain delivery, fresh state alone does not resume typing: the user must click
the page or explicitly Focus page. Failed batches are never replayed.
Document/viewport changes still invalidate coordinates and queued input; this is
distinct from an ordinary video-frame delay. The bounded buffer is not an offline
editor and does not preserve typing across document replacement or an unknown
delivery outcome.
On current remote hosts, a site's history/fragment update within the same document
preserves human gestures, queued input, cursor and display epoch. A panel may
therefore change the URL and fetch data without pausing the page's controls.
Such route changes still clear agent targets and invalidate pending agent actions.

A crashed/disconnected remote engine requires explicit Reload. The task preserves
safe locations/provenance, revokes old ownership, replaces its closed context/page
and returns user control. A failed old agent launch cannot destroy a tab the user
has taken over. Pending picker/clipboard observations check navigation and owner
again before applying their result; private picker targets produce visible feedback.

Legacy popup/dialog notices retain their originating tab ID. Open outside uses that
captured resource even after selecting another tab; closing it clears the notice.
Completed downloads similarly retain their initiating page identity and never
publish OS save paths. Unowned popups are closed without suggesting an unrelated
tab as the destination.

## Detached tab windows

Drag tabs along the strip to reorder them, or use Alt+Shift+Left/Right while a
tab is focused. Drag a tab vertically out of the strip to open its companion;
the existing window button remains available. Local and remote engines own tab
order and persist it with safe navigation metadata. Moves use a stable insertion
anchor, preserve page/driver/selection identities, and reject closed anchors
without partially mutating order. Rehosting and returning keep the same position.
Older remote hosts omit `canReorder` and retain ordinary tab selection/detaching.
Companions cannot reorder the source task's tabs.

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

**Local moves reload the page**, retaining the same tab ID and persistent task
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

## Remote channel and background execution

Remote hosts advertising `streamVersion: 1` use one private main-owned WebSocket
for frames, input, layout and state events; older hosts retain HTTP fallback. The
renderer uses the same narrow bridge and display acknowledgments. A remote task's
live tabs, network and agent control survive viewer disconnect/desktop exit while
the remote daemon stays alive. Agents can start their own runtime tabs without a
viewer. Backend restarts restore profiles and safe locations, not live documents
or automation grants. Local native guests retain desktop-process lifetimes.
See [the design and feature roadmap](../../../../../docs/task-browser-streaming.md).

Hosts advertising `videoStream: 'h264'` use bounded pushed Annex B packets and the
same typed frame event. `BrowserVideoDecoder` validates baseline SPS bounds, owns
one WebCodecs decoder/output and resets on a keyframe epoch. The component draws
and closes each `VideoFrame`; a failed decode sends an optional false receipt so
main selects JPEG for that presentation. Legacy five-argument receipts and JPEG
hosts remain compatible. The isolated `/browser-video` preview accepts externally
encoded fixtures for native capture; it adds no production bridge/test hook.

`videoWindow: 8` optionally enables a larger bounded delivery window. Main sends
the new start field only to hosts advertising it; older H.264 hosts retain their
original strict command shape and three-packet window. The backend adapts pixel
resolution while preserving frame metadata in logical page CSS coordinates, so
the input lane never treats an encoder quality change as a new page viewport.

New machine hosts attach `displayEpoch` to tab state and frames. The last picture
remains visible during navigation, but input waits for pixels from the current
document/viewport. Old queued packets retire their credits; future-epoch frames
reconcile metadata before presentation. Driver handoff and ordinary chrome
commands do not restart every display. After jitter, dependent video packets are
decoded in order while intermediate paints are skipped. Sustained backlog still
paints progress at a bounded cadence instead of waiting forever for an empty queue.

With `keyText: true`, printable key events include the local keyboard's text so
Blink honors a site's cancelled keydown. IME retains its explicit composition
path. Main's app keyboard interception excludes streamed page typing, including
Command/Control shortcuts and Option/AltGr. Copy/cut follows the focused frame
and open shadow input. These are bounded human-only operations, not agent
observation capabilities. Reload on a live engine uses Chromium reload semantics,
including fragment locations. Popup notices affect their originating tab.

## Stream startup and recovery

Every private-socket presentation first displays a JPEG, making current pixels
and input available while optional video discovery/encoding starts. Display
sequences stay monotonic across JPEG, H.264 and fallback; each codec retains its
own source receipts. A missing local renderer acknowledgment restarts that
display after five seconds, with a fresh stream identity. Task pages, driver
ownership and input are never replayed by this recovery.

The host captures every damage event and reconciles missed compositor updates
through a bounded restart of the same screencast while a reader is waiting. It
does not mix scaled screenshots with the live source. Static pages
do not need another animation or tab switch to reveal an input update. With the
optional `pointerExit` capability, leaving the canvas clears remote CSS hover
without blurring the site's input or cancelling a captured drag. Late input
receipts cannot overwrite a newer authoritative driver generation.

The native stream capture scenario now checks JPEG bootstrap before video
encoding, the actual H.264 decode receipt and trusted pointer exit, in addition
to themes, typing/IME, document epochs, narrow layout and display pause. Host
regressions inspect real streamed hover pixels and click side effects through
navigation and hide/show. These checks do not benchmark external SSH/WAN links.

Viewport changes serialize complete Chromium size/DPR updates and gate capture,
human input and agent actions until application finishes. A newer layout may
supersede intent, but cannot leave a partial device-metrics update behind. The
new control generation publishes together with its display epoch, and final
readiness publishes after the update. Regression coverage reproduces the former
stale-generation broadcast, plus an interrupted resize with a different DPR.

Commands await the task's viewer handshake, including the automatic first blank
tab. Concurrent metadata refreshes reuse an opening/live connection; blank tabs
do not start pixel reads. Display-only interruption messages do not claim an
unknown action outcome. Dispatched commands and human input still require
inspection after interruption and are never replayed.
