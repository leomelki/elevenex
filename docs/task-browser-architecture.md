# Task browser architecture

A task owns the browser, independently of conversations and displays. The engine
owns documents, cookies, navigation, driver authority and task-server grants. A
presentation owns placement, visibility, input readiness and frame receipts. A
network adapter decides how explicitly granted task-server connections reach the
server. These responsibilities must not be inferred from the selected machine or
from an empty guest partition.

## Placement and display

| Browser location | Engine | Task localhost | Display |
| --- | --- | --- | --- |
| Local (`desktop`) | Electron guest here | This device | Native embedding |
| Local · task proxy (`desktop-proxy`) | Electron guest here | SSH forwarding to task machine, when remote | Native embedding |
| Remote (`machine`, offered for remote tasks) | Sandboxed backend Chromium | Task machine | JPEG stream |

A local task defaults to `desktop`; a remote task defaults to `machine`. Choosing
`machine` for a local task through the legacy API still uses the local Electron
guest, now embedded natively. The UI offers only Local for local tasks, using
main-issued `availablePlacements`; it has no separate Direct/Stream display
selector. Legacy presentation IPC remains supported for older consumers. The
local backend retains its TCP transport, and private runtime pixel routes stay
closed to TCP.
The proxy choice forwards explicitly opened task localhost ports; public website traffic still originates on this
device. It is not an arbitrary HTTP proxy, a VPN or a public-traffic SSH tunnel.
The desktop engine still uses its internal policy SOCKS connector in both modes
to enforce destination grants and DNS pinning. “Local” means no task-machine
forwarding, not removal of that security boundary.

Browser Tools exposes the choice through `taskBrowserConfigure`, a named,
scope-bound operation. Only empty/start tabs may be replaced; live pages, pending
navigation and companions block it. The target host prepares before the old engine
is revoked and destroyed; an unavailable target leaves the original host usable.
Profiles are never copied. Safe location metadata is isolated by placement.
The original default desktop metadata key remains compatible. Placement choices
last for the retained task host in that window. Task eviction or application
restart returns to the default; no new persistence format is introduced.

## Ownership and implementation boundaries

- `apps/desktop/src/browser/host.ts` defines the task owner API and engine-specific
  guest/MCP capabilities. IPC and companion windows depend on this API. Only a
  desktop host can adopt native guests and execute the desktop automation mailbox.
- `TaskBrowser` owns the Electron task profile, pages, explicit task-server grants,
  safe persistence and native page lifecycle. `BrowserPage` owns its debugger,
  document and local frame producer. Electron cannot move an attached guest across
  windows; rehosting reloads the document with user control.
- `RemoteTaskBrowser` owns exactly one machine viewer identity/token, connection
  generation, metadata poll, tab state and outside-link forwards. Companion
  windows never instantiate another task, network owner or connection.
- `RemoteBrowserPresentation` owns exactly one layout, document-local epoch and
  sequence, frame request/cancellation identity, stream identity, acknowledgment
  and heartbeat. Its host/window dependencies are explicit; it imports neither
  Electron nor backend networking. Panel and companion instances share task
  metadata without copying a tab collection. Destroying one cancels its own work.
- Backend `RuntimeBrowserService` owns bounded task contexts and exclusive viewer
  leases; `RuntimeBrowserTask` owns profile/tabs/grants and active presentations;
  `RuntimeBrowserTab` owns its Playwright page, driver and bounded JPEG producer.
- Renderer feature state owns selected-task reconciliation. Reusable frame/input
  components own decode/input queues. Engine capabilities drive availability;
  optional native guest descriptors establish whether to mount an embedded page.
  Legacy partition/bootstrap fields remain available for existing renderers.

The two engines intentionally retain engine-specific page/driver implementation.
Electron synchronous input interception and Playwright asynchronous input have
different cleanup and navigation behavior. Do not force them through a generic
CDP wrapper or move mutable policy into serializable shared contracts. Shared
protocol cases exercise both input validators, alongside each engine's existing
privacy/ownership tests. Changes to authority require regression coverage at both
boundaries.

## Ordering, reconnect and failure

Each presentation has its own outgoing layout lane. The host advertises optional
`layoutLanes: true`; new clients use independent panel/tab sequences only then.
Older runtimes receive the original shared monotonic sequence. Old clients remain
valid against new hosts. Sequences live for the task connection owner, so returning
and detaching a tab cannot reset its lane below a prior accepted update. Backend
lane entries are pruned with closed tabs and reset on viewer-token rotation.

Each display holds at most one outstanding frame and awaits its own authenticated
receipt before requesting another. Hide, tab change, reconnect and destruction
cancel the request, rotate stream identity and reject late frames. A 750 ms local
layout heartbeat and backend presentation freshness guard stale input. Visible
companions keep the one task connection alive when the panel is hidden. When all
displays hide, disconnect revokes automation. Reconnection waits for an in-flight
disconnect before acquiring another token. Commands and human input never replay;
unknown outcomes require reconciliation and fresh user authority. The native
screencast source also reconciles after a stale start finishes, so an old display
cannot stop the currently visible stream.

Frames, DOM/AX, secrets, arbitrary CDP and raw errors remain unavailable to MCP.
Engine placement never grants an agent more observation or control. Host-side
validators, task/session membership, input generations, sandbox, TLS, Origin
checks, runtime private-socket authentication, bounded queues and destination
policy remain trust boundaries.

Handoff authorization captures the exact page and its control generation before
awaiting backend membership checks. A newer takeover, navigation, rehost, closure
or viewer rotation invalidates that request; an old authorization cannot restore
agent control. The remote HTTP adapter applies the same guard before dispatch.

Remote navigation completion belongs to one operation on one page engine. A
superseded load, or a load completing after engine replacement/destruction, cannot
publish an error or clear the newer load's busy state. Task selection and navigation
clear both the picker UI state and every tab's input interceptor together.

Local guest attachment restores tab emulation before loading the document and
accepting input. Theme and network flags alone are not engine configuration.
Network throttling enables its private CDP domain with zero body/post-data buffers;
native and remote tests measure actual request latency. Failed restoration closes
the partially configured engine and requires explicit reload. Companion commands
permit dismissal of their displayed notice while rejecting another tab's notice.

## Review findings and decisions

The review found four structural problems: remote companions recursively owned
full task objects; viewer-wide layout ordering could drop a different window's
updates; concrete-class unions and partition strings stood in for capabilities;
and validators disagreed on integer/IME selection bounds. This change replaces
the recursive lifetime with presentation composition, adds compatible layout
lanes, introduces host/capability contracts and runs a common validation corpus.
Engine selection is now an actual supported operation instead of an unused remote
flag inside the desktop engine.

The current JPEG source is bounded, backpressured and usable over the private
machine connection. It has no audio, browser accessibility relay, file transfer
or download relay. A fast video transport can replace frame delivery without
changing task/tab authority, network grants or presentation ownership. Add an
explicit negotiated capability before adding those features.

## Web and phone extension

A future web/phone client uses the private runtime implementation of `machine` placement and implements the presentation
host/window adapters plus its platform clipboard and input bindings. The backend
owns the same documents and driver policy; its engine does not depend on Electron.
Do not expose today's private viewer routes on the legacy TCP listener. A web
client needs an authenticated gateway with task authorization, origin/CSRF checks,
short-lived viewer credentials and bounded frame/input transport. The exclusive
viewer lease is intentional: simultaneous clients need a designed spectator or
handoff protocol rather than sharing the driver token. No web/mobile client,
public gateway, WebRTC service or new dependency is introduced in this change.

## Verification

The normal desktop lint/test/build commands cover contracts, renderer and main.
The native Electron smoke covers hardened guests, placement selection/guards,
detached windows, streaming and scoped bridge security. Backend browser suites
cover real private-socket transport and sandboxed Chromium as well as independent
layout lanes and shared validation cases. Presentation tests cover independent
receipts, stale frames/layouts, heartbeat and cleanup. Renderer tests cover revision
reset and stale replacement replies; native captures exercise Browser Tools in
both themes, narrow/reduced-motion and disabled states. These are local checks;
they do not establish a deployed SSH host, a packaged launch or a web/phone client.

Validated locally: desktop lint/test/build; backend browser suites and production
TypeScript; native Electron smoke; six browser-location captures with
[`verified: true`](../artifacts/desktop-capture/run-gFr9vN/report.json), including
keyboard selection and focus restoration. The broader backend `tsconfig.json`
check includes unrelated failing spec types outside `desktop-browser`; the
production `tsconfig.build.json` check passes. No dependencies or lockfiles changed.

The follow-up review adds regressions for placement replacement after navigation
or task selection, picker exit and stale observations, stable local tab recovery,
lazy selection after closure, pinned-task capacity, concurrent runtime eviction,
shutdown during preparation, malformed viewer tokens and discovered-port
invalidations. Native guests now have an engine-specific bootstrap identity;
the stable tab ID survives engine replacement. Runtime owner allocation is
serialized and bounded independently of ongoing viewer operations.

Follow-up checks passed: desktop lint/test/build (154 main tests, seven capture
tool tests and 643 renderer tests), 27 backend browser tests including real
Chromium/private-socket integration, backend production TypeScript and native
Electron smoke. Six [placement captures](../artifacts/desktop-capture/run-PmeLOc/report.json)
and ten [new-tab captures](../artifacts/desktop-capture/run-6NYGTI/report.json)
report `verified: true`; inspected images cover both themes, keyboard focus,
narrow/reduced-motion, empty and error states. Remote transport fixtures and local
Chromium do not establish a deployed SSH host or a packaged-app launch.
