# Task browser automation and remote host

`DesktopBrowserService` keeps the existing at-most-once desktop MCP mailbox and
additively routes an explicitly selected runtime worker to `RuntimeBrowserService`.
The tool is authenticated to its task/session and returns allowlisted ownership
metadata only. It cannot observe DOM/AX, pixels, page strings, headers, secrets or
arbitrary CDP. Driver generations are rechecked after every await; input is never
replayed after interruption.

The remote host uses pinned `playwright-core@1.61.0` over a private Chromium pipe.
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
ten seconds; tasks with tabs remain alive independently until explicit task or
backend shutdown. Live tasks are never silently evicted for capacity. Cookies, localStorage,
IndexedDB, service workers and cache storage remain in task-incarnation profiles
under `task-browser-profiles/` in application data, including across backend
restarts. Profiles never share the user’s ordinary browser directory. Safe metadata contains
only committed locations, without query/hash, never page storage or frames.

Task server grants are explicit. Port discovery is only a suggestion. Public DNS
is pinned to validated public addresses; private/rebinding/control destinations
are denied. HTTP(S), WebSockets and ordinary site storage/API behavior use actual
Chromium. Permissions/client certificates/popups/dialogs are denied with truthful
needs-user attention. Remote audio/accessibility/file selection/download relay
are unavailable in this first JPEG mode. Open outside uses a separate profile.

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
three-second presentation freshness and the existing viewer expiry. A detached
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
