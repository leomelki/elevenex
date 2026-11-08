# Task browser automation and remote host

`DesktopBrowserService` keeps the existing at-most-once desktop MCP mailbox and
additively routes an explicitly selected runtime worker to `RuntimeBrowserService`.
The tool is authenticated to its task/session and returns allowlisted ownership
metadata only. It cannot observe DOM/AX, pixels, page strings, headers, secrets or
arbitrary CDP. Driver generations are rechecked after every await; input is never
replayed after interruption.

The remote host uses pinned `playwright-core@1.61.0` over a private Chromium pipe.
Streamed WebAuthn uses Chromium's fixed proxy extension and a human-approved
desktop authenticator broker. See [WebAuthn architecture and native limits](../../../../docs/task-browser-webauthn.md).
`RuntimeBrowserPool` owns up to four sandboxed Chromium processes, persistent
task profiles and the bounded managed installation;
`RuntimeBrowserTask` owns its persistent shared profile, task SOCKS connector,
persistence and twelve tabs; `RuntimeBrowserTab` owns its page, debugger, viewport,
human-input generation and bounded JPEG producer. Four tasks may be retained.
Startup tries the managed browser, installed Chrome, then an owned, cancellable
three-minute browser install under application data. Installation needs network
access and a supported Chromium host. It never adds `--no-sandbox`, disables TLS
validation, or bypasses CSP. Debug logging that could expose page data is refused.

`runtime-browser.controller.ts` provides additive `/api/desktop-browser/runtime/tasks/:taskId`
initial/connect/state/command/layout/input/frame/disconnect routes. **They require
the managed private IPC socket**, reject HTTP TCP callers and browser Origin/Fetch
headers, and use a rotated per-task viewer token for mutations/state/pixels. The
managed SSH relay supplies private remote transport; no pixel channel is added to
the legacy unauthenticated TCP API. A second viewer receives a conflict. Upgraded hosts advertise `streamVersion: 1`
and use one private WebSocket for binary frames, state events, input and layouts;
the HTTP routes remain a compatibility fallback. Main owns
all tokens and transport; the trusted renderer receives narrow typed methods only.

The source encodes a maximum 1920×1440 JPEG (3 MB), one unacknowledged frame and
one replacement. Display acknowledgments adapt quality/resolution and encoding
pauses on slow or hidden viewers. Logical viewport caps at 2560×1600, DPR at two.
Human key/text/IME/clipboard/mouse/scroll input is bounded, ordered and gated by
current driver and visibility. Disconnect removes display/input authority while preserving live task pages,
network access and agent ownership. No queued automation resumes. Viewer TTL is
thirty seconds; tasks with live tabs remain alive independently until explicit task or
backend shutdown. Live tasks are never silently evicted for capacity. Cookies, localStorage,
IndexedDB, service workers and cache storage remain in task-incarnation profiles
under `task-browser-profiles/` in application data, including across backend
restarts. Profiles never share the user’s ordinary browser directory. Safe metadata contains
only committed locations, without query/hash, never page storage or frames.

Task server grants are explicit. Port discovery is only a suggestion. Public DNS
is pinned to validated public addresses; private/rebinding/control destinations
are denied. HTTP(S), WebSockets and ordinary site storage/API behavior use actual
Chromium. Permissions and client certificates remain denied. Popup pages retain their task
context and opener for OAuth; site dialogs and file requests use human-only pending
requests on hosts advertising `workflows: true`. Bounded file transfer routes require
the private viewer lease. Remote audio/accessibility remain unavailable. Open outside uses a separate profile.

Tests include the real Nest private-socket transport and sandboxed Chromium,
plus driver/mailbox/persistence/logging/validation boundaries. This does not
establish an external SSH deployment or Windows/Linux packaged runtime validation.

Remote human input accepts non-nested batches of at most 32 events / 65,536 text
code units. Clipboard remains isolated for client OS semantics. Each event checks
task, owner, document generation and visibility again; a partial batch has an
unknown outcome and is not retried. Even a stale human event revokes agent control
before it is rejected for outdated coordinates. Driver generations advance on
navigation, viewport changes and human takeover; merely pausing the display does
not revoke agent control. Explicit Reload recovers a
closed/crashed engine; metadata and fresh user ownership survive, queued actions do not.

Nest owns SIGINT/SIGTERM shutdown, including contexts and browser children.
Playwright's global process signal handlers are disabled so they cannot swallow
backend termination. This also preserves application-owned process supervision.

Host allocation serializes metadata preparation and eviction, with at most eight
pending task preparations. Concurrent opens cannot dispose the same retained task
twice or exceed the four-task limit. Shutdown rejects new work, drains in-flight
preparation, then saves and closes retained owners; a late preparation cannot
publish another viewer or overwrite saved navigation with an uninitialized task.
Discovered server changes advance the state revision without granting network
access, so state events (or legacy incremental polling) update suggestions without
granting network access.

The private layout route accepts optional `tabId` and `detached` fields for
companion presentations. Omitted fields retain the original active-tab behavior.
All views share the original viewer token; a companion does not acquire another
lease. Per-tab visibility gates frames and every input event independently, with
fifteen-second presentation freshness and the existing viewer expiry. A detached
layout never selects another tab. Returning removes its presentation; disconnect
clears presentations and human-input authority while preserving agent control. The public TCP boundary is unchanged. Agents may start the runtime without a
viewer; page observation and user-tab handoff restrictions remain unchanged.

Optional `layoutLanes: true` state capability advertises independent panel/tab
layout ordering. Older clients' shared sequences remain valid. The desktop keeps
legacy shared sequencing for hosts that omit the capability. Lane state is
bounded to live tabs and resets with the viewer lease. See the
[architecture review](../../../../docs/task-browser-architecture.md) for placement,
presentation ownership and authenticated web/phone extension boundaries.

See [the persistent streaming design](../../../../docs/task-browser-streaming.md)
for protocol bounds, persistence guarantees, extension slices and research.

`videoStream: 'h264'` optionally negotiates push video on the private socket.
`runtime-video` owns a negotiated display window and presentation lifetime;
`runtime-video-host` owns the shared capability catalog, fair work budget and
encoder cleanup. VideoToolbox, NVENC, QSV, AMF, VA-API, hardware Media Foundation
and V4L2 profiles are selected only after real synthetic encode/decode probes,
with managed/host FFmpeg discovery and software fallback. Per-view quality adapts
to CPU quota, memory, concurrent views and encoding/display feedback. New clients
negotiate up to eight packets through `videoWindow: 8`; older peers retain three.
Hiding/disconnecting a viewer closes encoders while retaining task pages. Older
clients retain JPEG. CDP capture still supplies JPEG input to the encoder; no raw
or zero-copy capture, audio or WebRTC is implied by this capability.

`RuntimeBrowserInput` owns the page's ordered human writes and pressed state.
Hidden/noninteractive presentations, resize, document replacement and ownership
changes invalidate queued writes and release held keys/buttons/composition. Agent mouse
actions await that cleanup. Editing intents use fixed Blink commands so the
viewing device's undo/redo/select-all do not depend on the host OS. Focus emulation
is page-owned rather than bringing companion pages to front on every heartbeat.
Congestion reduction applies to the attainable frame rate after CPU/pixel budgets.
See the [remote interaction audit](../../../../docs/task-browser-remote-audit.md)
for this revision's behavior and the remaining feature boundaries.

New hosts advertise `keyText: true` and `inputWindow: 4`. Printable keydown and
its native text travel together so websites can cancel insertion. Up to four
whole batches may be outstanding; a per-tab lane preserves their order, bounds
admission and rejects old presentation epochs after hide/show or reconnect.
Clipboard remains a barrier and follows focused cross-origin frames/open shadow
roots. A separate generation-checked `release` event cleans up held human state
after queue pressure or an uncertain outcome; it never retries text or actions.
Ordinary input does not publish unchanged task snapshots.

Cursor hit testing is optional presentation work, outside the ordered input lane.
`RuntimeBrowserCursor` coalesces positions at a 32 ms cadence with at most one
page evaluation in flight. A slow style/layout read cannot delay mouse-up,
typing or capture invalidation, or turn an already delivered event into a failed
action. Late cursor results require the same document, input epoch and driver
generation; engine replacement and teardown retire its pending work.

`displayEpoch` identifies the document and logical viewport independently of
driver ownership. Document replacement clears old captures, serializes screencast
restart and seeds the current page; H.264 starts a new keyframe epoch at that boundary.
Site-driven history/fragment changes retain the document, display epoch and
human input, so a routed panel stays interactive while it fetches data. They
still clear agent targets and invalidate pending agent actions. Chromium's
separate document/within-document events establish that boundary; a URL update
alone does not mean the document was replaced.
Both binary transports preserve the field. A producer always announces its end,
including normal presentation expiry. Receipt deadlines tolerate fifteen seconds
of jitter; no input is replayed. Layout acknowledges intent while installation is
pending, and concurrent tasks share one managed installer. Unviewed blank user
tabs may be evicted for capacity; live pages and agent-owned tabs are retained.

Task networking handles public IP literals without DNS, uses the OS resolver for
host configuration, and pins validated answers while racing address families.
Authorized localhost aliases can reach IPv4- or IPv6-only task servers. Private
answers, unknown task ports and application control destinations stay denied.

## Capture reliability

`RuntimeBrowserCapture` owns the tab's CDP screencast listener, serialized
start/stop commands, latest image, one cancellable read and one refresh in
flight. It keeps its source sequence across engine replacement; document/viewport
epochs and capture revisions reject old engine events.
Navigation completion restarts capture without waiting for a layout heartbeat.

Capture uses `everyNthFrame: 1`: Chromium damage can be a single hover or button
update, so sampling damage events can leave the final image stale indefinitely.
Video pacing and the bounded latest-image slot handle rate control downstream.
A viewer-owned read also runs a coalesced screencast refresh: missing input
updates are checked at 100 ms cadence, and idle reconciliation is limited to
once a second. Refresh stops/starts the same source to seed its current viewport.
Do not mix scaled `Page.captureScreenshot` calls into this source: clipping uses
document coordinates and temporarily changes compositor emulation, producing
wrong scroll regions or white frames. Identical JPEGs do not
advance the source sequence or trigger video encoding. No watchdog runs without
a waiting reader; hide, abort, navigation and teardown release its timers.

The desktop bootstraps every new presentation with an ordinary JPEG credit,
then starts optional H.264. Capability discovery completes before taking the
first video source image. `RemoteBrowserFrames` owns separate JPEG/video source
cursors and a monotonic display sequence, including codec fallback; a JPEG
receipt can never accidentally acknowledge an H.264 packet. The desktop restarts
only a presentation whose local renderer receipt is missing for five seconds.
This never reconnects task execution or replays input.

Frame reads race independent layout updates. If their presentation hides or
closes before delivery, the private stream completes the read with no image
instead of reporting a failed action and reconnecting the task. Invalid parallel
reads and expired viewer authority remain errors. Display failures are reported
separately from mutations whose outcome may be uncertain.

New hosts advertise optional `pointerExit: true`. The human-only
`{ kind: 'pointer-exit' }` event moves the host pointer outside the viewport
without changing keyboard focus or held keys. Captured drags retain their normal
release path. Older hosts receive only their existing supported input events.

Viewport changes serialize complete Chromium size/DPR updates and gate capture,
human input and agent actions until application finishes. A newer layout may
supersede intent, but cannot leave a partial device-metrics update behind. The
new control generation publishes together with its display epoch, and final
readiness publishes after the update. Regression coverage reproduces the former
stale-generation broadcast, plus an interrupted resize with a different DPR.
The viewport update explicitly sets the visible backing size as well as device
metrics: persistent headless Chrome can otherwise subtract native chrome insets
from screencast dimensions while reporting the requested logical viewport.

CPU-only streams use the same 1920×1440 resolution bounds as hardware, with a
30 FPS ceiling and capacity-based reductions. Relative resolution tiers preserve
tall panels; they do not round them down to landscape width buckets. Bitrate
retains a text-quality floor at low FPS, and the encoder buffer reserves at least
two frame budgets so sparse updates do not become heavily quantized keyframes.

## Human site workflows

`runtime-workflows` owns expiring dialog/file handles and their task-wide budget;
`runtime-download-policy` owns Chromium progress limits and its debugger attachment.
The private `transfer` endpoint accepts only request identities and bounded chunks,
never caller-provided host paths. Uploads cap at sixteen files / 32 MiB aggregate
per task; two retained downloads cap at 32 MiB each. Site requests, prompt contents
and file bytes are excluded from the separate agent reply allowlist and metadata
persistence. Viewer loss clears pending requests without replay.

Popup adoption keeps the actual page and opener in the task context rather than
reopening a URL. Background popups do not steal another selected user tab.
`pointerLock: true` advertises genuine Chromium lock state and bounded relative
motion input; the viewing device requires its own explicit user gesture. Native
cursor metadata is restricted to CSS keywords. These optional fields leave older
JPEG/video/input contracts available.

### Pointer-lock ownership and input ordering

`runtime-pointer-lock` owns a tab's current lock and monotonic acquisition epoch.
`runtime-pointer-lock-target` owns CDP subscriptions for each renderer target;
local child frames share their parent's target and cross-process iframes receive
separate attachments. The document-start observer runs in a private isolated
world. Main-world scripts cannot replace its native getter or call its binding.
Each context receives a private ticket through CDP's unique context ID, and
notifications require that ticket and an increasing sequence. A reused numeric
context ID therefore cannot accept a former renderer's delayed notification.
`document.open` also rotates the ticket and reinstalls listeners, even when its
execution context survives. Reads, exit commands and teardown are ticket-bound
so delayed cleanup cannot affect the replacement document's observer or lock.
Each trusted lock-change event creates a new lease even when rapid release and
reacquisition make consecutive notifications both observe a locked element.

Relative motion validates ownership, visibility, document/control generations
and the cached lock epoch in memory. It never enumerates frames or waits for a
JavaScript lock-state query. New tab/surface replies include optional
`pointerLockEpoch`; viewers echo it on relative motion and unlock. Its presence
advertises support without changing the original `pointerLock: true` capability.
Older viewers may omit it: the host binds their requests to the epoch at
admission, preventing queued requests from inheriting a later acquisition.
Only viewers echoing an epoch can also distinguish old movement still in transit
when the host reacquires the lock. Older hosts receive the original event shape.

Reconciliation is outside input delivery. Initial context authorization reads
its current state; while locked, the owner alone is checked once per second,
with a 250 ms deadline. A stalled read revokes admission immediately and queues a
single-flight owner-confined exit. The outstanding read remains single flight until it
settles or its context disappears; deadlines cannot accumulate evaluations.
Navigation, frame/context removal, hide, disconnect, handoff and disposal also
revoke admission synchronously. Cleanup never scans unrelated frames. Native
exit and event processing can still wait for the receiving renderer; Chromium
acknowledgements and a game's own JavaScript are not real-time guarantees.

`runtime-input-lane` separates submission order from native receipts. At most
four consecutive single relative-movement requests with identical control,
document, lock, button and modifier identities may overlap. Keys, buttons,
clipboard operations, different motion identities and complete batches are
exclusive barriers that drain all previous receipts. The task retains its
eight-request admission bound; low-level cleanup is coalesced and ordered.
Receipts still mean native delivery, rather than merely entering a queue.
Failed/uncertain movement is never replayed. The viewer reserves one additional
bounded unlock request beyond its normal four credits so Escape can revoke host
admission while ordinary receipts are stalled. Native key/button cleanup remains
ordered. Engine reset closes a busy page before waiting for its input cleanup.
An unlock receipt confirms revoked admission immediately, independent of queued
motion or clipboard receipts. Queued presses, moves and wheel input cannot cross
a pointer-mode change; mouse-up cleanup retains its existing ordered behavior.
Ordinary pointer input waits for native exit to settle; revocation alone cannot
turn an absolute move into accidental relative motion. A context cannot publish
a fresh grant while its previous exit is in progress, and an uncertain native
exit keeps ordinary pointer input gated until a real unlock or context removal.

On macOS, each task-owned Chromium context retains one inert `about:blank` tab
outside its twelve product tabs. Closing the last headless native window causes
subsequent pages to reject genuine pointer lock; DOM focus emulation cannot
restore that eligibility. The anchor keeps that window alive across page
creation/closure, has no application instrumentation or site content, and dies
with the context. Other platforms retain their original page allocation.
The pool tags the anchor by page identity so tab limits and the orphan-popup
sweeper exclude it. An unrelated `about:blank` page receives no exemption.

**Native routing limit:** stock Chromium's positional CDP mouse dispatcher still
hit-tests accumulated coordinates. Crossing a cross-process iframe can deliver
motion to that frame instead of the pointer-lock owner. The integration suite
retains the desired owner-delivery assertion as an explicit `it.failing` case;
it must be converted to a normal regression when native routing is fixed.
Reliable arbitrary iframe crossing requires a browser-side routing fix or a
native relative-input operation. This change retains the standard Chromium
distribution and its update workflow. The observed lease, ordered input and
viewport-edge contracts do not establish complete native routing parity.
The preferred engine fix routes mouse movement, buttons and wheel input to
Chromium's native lock-owning widget before positional hit-testing, preserving
trusted events, physical metadata and delivery acknowledgements. That fix can
remain behind the existing host/renderer contract; a new native operation would
need optional capability negotiation and the same no-replay policy.

## Human-picked source locations

Human Point and ask inspection optionally resolves React development file/line
metadata through `@elevenex/browser-inspection`, shared with desktop-local pages.
See [the resolver guide](../../../../packages/browser-inspection/README.md) for
supported metadata, source-map/network limits and unavailable cases. The runtime
passes only allowlisted source identifiers and coordinates in `picked.source`;
it does not expose source-map bodies, props, text or screenshots. Agent-driven
inspection retains its structural-only default. Source lookup is guarded by the
same document, viewport, control and picker lifetime as the human input.
