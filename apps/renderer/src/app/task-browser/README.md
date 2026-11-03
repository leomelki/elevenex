# Production task browser

`TaskBrowserComponent` is the production adapter for the presentational
`BrowserView`. `WorkspacePanels` supplies the additive `[workspaceBrowser]`
slot. The machine workspace supplies a backend scope and **task**, independently
of its selected conversation. Browser questions and error reports carry a captured
scope/task/session identity and are staged in the selected session's composer;
the user reviews and sends them. They never submit a prompt automatically.

## Ownership and privacy

Main owns every `WebContentsView`, transport and browser partition. Untrusted
pages have sandbox/context isolation/web security, no preload/Node/Elevenex
bridge, denied permission requests/downloads/popups/dialogs/client certificates and confined HTTP(S)
navigation. Production app CSP and navigation guards are unchanged. Page titles,
raw console messages, request bodies/headers and URLs are never exported to the
agent. Error observation retains bounded counts only.

An agent-readable DOM/accessibility snapshot or screenshot cannot establish
complete secret redaction for arbitrary pages (including canvas, frames and
closed shadow roots). Those channels are **withheld for every page**. Screenshot
to chat is explicitly unavailable. The feature does not claim masking. Secret,
editable and embedded controls require user interaction; there is no agent text
entry operation. Sign-in, 2FA and payment use the explicit needs-user state.

The real picker consumes native page input and resolves the element at native
viewport CSS coordinates in a separate JavaScript world. Its response contains
only a structural `nth-child` selector, tag and bounding rectangle. Form fields,
editable ancestors, embedded frames and open shadow hosts are excluded. Page
text, source locations and element screenshots remain unavailable. No user text,
DOM attributes, CSS selectors from the site or framework source internals are
inferred as trustworthy source locations. After selection, the native page
pauses/detaches so the question form can receive focus safely. Asking stages the
question and geometric context in the explicit composer flow.

## Driver protocol

Every tab has a synchronous driver lease and monotonic generation. Agent tabs
remember their creating session. User tabs start with user control. An explicit
handoff authorizes the chosen session against the task on the backend, assigns
that **specific** session and advances the generation. Hand back returns to the
waiting agent; Tools can explicitly allow the selected conversation instead.
An authenticated MCP caller can drive only its own task and its assigned tabs.
Agent-created tabs open in the background while another driver controls the
active tab, preserving user focus and unfinished private input. Agents cannot
select over a user/other-agent active tab or close user-created tabs.

Native mouse/keyboard input revokes the agent generation synchronously **before**
Chromium accepts the user event. Every async action rechecks generation, scope,
selection, visibility and navigation identity immediately before native input.
Input is a single synchronous dispatch with no typing queue or delayed replay.
A two-second action deadline revokes the generation before an expired DOM or
forward reply can dispatch input; one pending inspection per tab bounds hung
page observations. Selection changes and disposal cancel the action lease.
Hidden/loading/crashed pages reject agent input. Native mouse actions do not
steal OS focus: fixed isolated-world event receipts confirm trusted input
delivery, without exposing content or field values. Missing confirmation is an
unknown outcome and hands control to the user; it is never retried automatically. The MCP `task_browser` tool
supports list/open/select/close/navigate/back/reload/click/scroll/needs-user through a bounded,
at-most-once mailbox; generations come from a fresh list reply. It does not expose
arbitrary JavaScript, CDP, screenshot, DOM or filesystem operations.

Leaving the selected task explicitly deactivates its mailbox and revokes control;
merely closing the Browser panel detaches its page while retaining task state.
Inactive/deleted-task replies close their native resources.

The mailbox admits 64 desktop leases and 16 pending requests per lease; a delivered
request is never redelivered. Disconnect, cancellation, timeout, task change or
scope replacement drops pending work. An uncertain receipt never retries an
accepted action. Reconnection establishes a new mailbox token and revokes old
driver generations. The backend additionally allowlists replies at the agent
boundary, rejecting accidental content-bearing fields.

Errors are offered through **Send to agent** as composer context. The optional
"Share error counts during agent work" setting lets the browser tool receive
counts only for tabs currently owned by the agent. It does not share raw error
messages or request details, or inject autonomous conversation prompts.

## Navigation, storage and layout

Each window keeps at most four task browsers, each with twelve tabs and at most
100 native history entries per tab. Switching conversation/panel preserves the
live tab, page state, scroll and history. Task changes detach the old surface;
least-recently retained task state can be evicted. Durable metadata records a
bounded URL/width/creator/selection snapshot under application data; query and
fragment are omitted. Reopening restores safe locations and tab provenance with
**user control**, lazily loading the selected page. It never restores or replays
agent actions. An edited SSH destination or a newly created task reusing an old numeric ID
gets a distinct persistence identity. Machine name/color changes retain it.

Each tab has a fresh in-memory partition. Cookies, workers and storage are
isolated from the app, other tabs/tasks/windows and previous app launches.
Closing/evicting a tab destroys its contents and clears its storage. Sign-in is per live tab: a retained in-memory task cache may keep it, but
metadata restoration after destruction/app relaunch does not. No credential-sharing
policy is implied. Navigation metadata is ordinary private application data, not a
credential vault.

Main resolves remote loopback URLs through ephemeral leases on the existing
managed SSH transport. A private task SOCKS5 connector keeps the **logical URL**
in the page itself, preserving CORS, cookies, TLS authority and WebSocket origins.
Unknown loopback ports are blocked until explicitly opened in that task; page
content cannot allocate forwards or fall through to desktop localhost. Public
DNS is resolved off the main Node thread pool, bounded to 32 in-flight names and
checked for private/reserved addresses before connecting to a fixed IP, preventing
DNS rebinding. Private LAN addresses are unavailable through the remote browser;
use the task's explicit loopback server. The connector binds only loopback, bounds
handshakes to 1 KiB / five seconds and 128 sockets, applies stream backpressure,
and never parses or records HTTP bodies/TLS/WebSocket payloads. No general TCP
operation is exposed through IPC. Open outside uses the allocated listener URL;
the system browser does not use the private connector.

Running saved-action output supplies at most 32 task server-port suggestions,
cached for two seconds; users can also enter a port or HTTP(S) URL. Forward and
connector leases close with their task/window/scope. Task switching disconnects
network streams and denies new requests while retaining the live DOM/history;
returning lets the site's normal connection recovery run, or offers explicit
Reload. Conversation and panel switches within the same task retain networking.
Chromium's web security, certificate validation and denied permission policy
remain in force. A self-signed server needs a valid development trust setup.

`NativePageLayout` measures the trusted page slot, including responsive phone
width and scroll/clipping, and sends bounded monotonic layouts. Native content
is detached during panel/phone-width motion, hidden panels, machine/task changes, modals,
menus and page-question forms. Main clips bounds to the content viewport and
fails closed if its 750ms layout heartbeat expires. A main-owned presentation
epoch prevents an in-flight old visible layout reattaching after Hide. Status
folds track measured bounds without blurring a user typing in the page. Parent native input hides
the surface before app overlays can open. Interruptions/reduced motion settle
through the existing shell/Fold/BrowserView motion rather than animating a second
native layout tree. Page-local accent/cursor decoration is purely visual; driver
security does not depend on page DOM.

Theme and network controls use narrow main-owned CDP commands on a tab-owned
debugger attachment, detached on destruction. No CDP capability crosses the bridge. Native placement converts app CSS pixels
to window DIPs and synchronizes page zoom; picker/agent coordinates remain page
CSS pixels. Layout revisions reject an action measured before a viewport change.
Changing an established responsive width/zoom revokes agent control and clears
stale target decoration, so queued coordinates require a fresh explicit handoff.
Height changes (including workflow bars) advance the input generation while
retaining ownership; queued coordinates still require a fresh state read.
The server controls actual contents; unsupported operations return a visible
error rather than silently succeeding.

The driver pill is a keyboard-accessible Focus page action. It takes user control
before focusing native content; Shift+Escape returns to the browser chrome. A
focus intent waits for a fresh, visible layout and cannot reattach over an overlay.
