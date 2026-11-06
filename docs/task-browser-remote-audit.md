# Remote browser interaction audit

Reviewed 2026-11-06 against the current desktop, renderer and task-machine host.
The remote browser already has persistent isolated profiles, real Chromium,
private multiplexed transport, bounded H.264/JPEG, explicit driver generations,
companion windows and legacy HTTP/JPEG compatibility. This revision concentrates
on correctness and responsiveness within those boundaries.

## Implemented

| Gap | Result |
| --- | --- |
| IME sent only a final string | Live composition updates, bounded coalescing, explicit cancel and one commit. |
| Option/AltGr characters blocked by key handling | Printable input retains the native text event while remote key events remain ordered. |
| Undo/redo and select-all interpreted using the host OS | Human edit intents invoke fixed Blink commands; no arbitrary editor/CDP command crosses the bridge. |
| Held keys/buttons survived focus loss and hidden presentations | Renderer focus/pointer-capture cleanup and a page-owned host input lane release keys/buttons and cancel composition/drag. Host cleanup also covers navigation, resize and handoff. |
| Pointer moves always declared no button; double clicks always counted as one | Held button follows a drag, with bounded double/triple-click counting (500 ms, four CSS pixels). |
| Coalescing crossed scroll targets or modifier/button changes | Coalescing preserves target and modifier/button boundaries; only consecutive uncommitted composition updates replace each other. |
| Companion layout heartbeats repeatedly brought pages to front | Page-owned focus emulation avoids periodic focus stealing between presentations. |
| Every displayed frame reallocated the canvas | Reuse the backing store until frame dimensions change. |
| Late frames/codec callbacks could affect a replacement task/decoder | Clear pixels on hide/task change; reject stale decode work, close retired frames, ignore retired errors and acknowledge the original task. |
| Congestion reduced a theoretical ceiling without reducing the actual resource-limited rate | Apply congestion reduction to the achievable frame rate, retaining steady-RTT behavior. |
| New document state could enable clicks over old pixels | Independent document/viewport epochs tag captures through both transports. Input waits for matching pixels; a decoded future frame waits for Angular's surface update. |
| App shortcut interception blocked streamed modifier keys | The root and companion boundaries distinguish native guests from the streamed page's textarea. Native registration/preload tests exercise modified input with jittered replies. |
| A normally ended video producer left its viewer waiting forever | Every producer termination notifies its subscription, including expired presentations. |
| Serial typing waited for every network round trip | Capable hosts negotiate four outstanding whole batches, serialize their order, retain clipboard barriers and release held state after queue pressure or uncertain delivery. Older hosts retain serial input. |
| Input and layout heartbeats repeatedly broadcast unchanged task snapshots | Only semantic state and presentation changes publish updates. Ordinary chrome commands retain independent video streams. |
| Backlog replay painted every obsolete image | Decode every dependent packet, skip intermediate paints while catching up, and retain periodic visible progress if the queue stays busy. |
| Reload, popup ownership and focused-frame clipboard differed from browser behavior | Use real Reload, identify popup openers, leave unrelated tabs alone and follow focused frames/open shadow inputs for text copy/cut. |
| First launch and network configuration caused avoidable failures | Layout no longer waits for installation; installers coalesce. IP literals bypass DNS, OS host configuration is honored, and validated addresses use family fallback. Blank user tabs do not permanently consume task capacity. |
| Fast typing filled the small queue during long pauses, and healthy refocus cleared unsent text | Keep up to 512 unsent events / 65,536 text code units, retain writing on healthy refocus, and test sustained 240-character typing through a twelve-second receipt stall. A stable page does not require new video frames for typing. |

No new dependency, wire method, network permission or agent observation channel
is introduced. Input still stops after an unknown delivery outcome; cleanup only
releases held state and never retries writing or navigation.

Viewer leases now tolerate thirty seconds without incoming activity, companion
presentations fifteen seconds and video receipts fifteen seconds. Tests include a
twelve-second artificial transport pause and out-of-order input receipts. These
are bounded recovery policies, not a claim that an offline link remains interactive.

## Remaining gaps and implementation boundaries

| Priority | Gap | Appropriate next implementation |
| --- | --- | --- |
| High | Uploads and downloads | Human-only, viewer-bound transfer IDs; bounded streamed files, device dialogs in main, path confinement on the host, cancellation and cleanup with the viewer. Never buffer arbitrary files in renderer IPC or expose host paths. |
| High | OAuth popups and dialogs | Adopt bounded popup tabs in the same task profile while preserving opener semantics and task network policy. Dialog IDs must bind to the document/driver generation; display and resolve them through human-only chrome. |
| High | Cursor shape, link preview and context menu | Narrow human-only presentation metadata, enum-validated cursors, sanitized link locations and explicit context actions. Handle iframe/shadow-root targets and reject stale pointer results. Do not send arbitrary CSS cursor URLs. |
| High | Rich clipboard and page Clipboard API | Support bounded MIME types and page copy/paste events under current human ownership. Text copy/cut now follows focused frames and open shadow inputs; richer formats remain unavailable. |
| Medium | Native browser shortcuts, find, zoom, custom viewports and hard reload | Route explicit browser-chrome intents to the task owner; keep page shortcuts scoped to the focused page and logical viewport separate from encoded resolution. |
| Medium | Audio, media permissions and accessibility | Separate owned media/accessibility adapters with explicit permission and resource lifetimes. Pixels alone cannot provide native screen-reader semantics or audio. |
| Medium | HTML drag-and-drop, file drops and touch gestures | Add typed drag/touch lifecycles and cancellation beyond the repaired mouse dragging path; file drops should reuse the transfer boundary. |
| Medium | Sharper idle text and lower capture/encode cost | Measure real WAN latency/quality first. CDP JPEG → H.264 still requires decoding/re-encoding and chroma subsampling; examine a full-resolution idle refresh or native capture before introducing another transport. |
| Separate policy | Agent DOM/AX, screenshots, text entry, evaluation and debugging | The current tool deliberately withholds page observations. Implementing these requires an explicit privacy/observation design; this interaction revision preserves that policy. |
| Separate product scope | Multiple spectators, web/mobile clients, profile import and passkeys | Add authenticated presentation gateways and scoped identity/permission ownership; persistent task profiles do not imply access to the user's ordinary browser profile. |

## Research and verification

[T3 Code's server browser](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/preview/ServerBrowser.ts)
provides useful comparison points for viewer-owned pressed keys/buttons, clipboard,
file transfer, popup and dialog lifetimes. Its framework and security assumptions
are independent of Elevenex's.
[Chromium's Input protocol](https://chromedevtools.github.io/devtools-protocol/tot/Input/)
defines fixed editing commands, held-button state and composition cancellation;
the APIs used here were also checked against the locked Playwright protocol types.
[WebCodecs](https://www.w3.org/TR/webcodecs/)
defines asynchronous codec support and decoder/frame resource ownership.

Focused regressions use real sandboxed Chromium for composition, editing, repeat,
cleanup and rejected stale input. Renderer tests exercise the production component
through DOM events, frame/task races, backing-store reuse and retired decoder
callbacks. The reusable native capture is
`scripts/desktop-capture/scenarios/browser-stream.mjs`, against
`pnpm desktop:preview` on port 4310. It uses real Chromium pixels and managed
FFmpeg H.264 through the production component with a preview-only bridge.
This is neither a WAN benchmark nor a packaged/foreign-OS verification.

Delivery verification: 63 browser-host tests, 167 desktop tests, seven capture-tool
tests and 669 renderer tests pass. Desktop lint/build, backend production TypeScript,
typed lint for the changed host modules, the native Electron smoke and the separate
native remote-input regression pass. Existing host formatting differences are
excluded from typed lint; the new test modules also pass ordinary backend lint.
The final capture includes native paired text and a deliberately future document
frame waiting for Angular's matching surface. Its report is
`artifacts/desktop-capture/browser-typing-final/report.json` (`verified: true`, no
errors/warnings); all four PNGs were inspected. The preview process was stopped.
The repository scripts ran directly through Node because the installed pnpm tried
to download its pinned manager and could not fetch it. Dependencies were unchanged.

An additional whole-backend test-source TypeScript check still reports pre-existing
errors in unrelated test fixtures. Browser integration fixture typing was corrected;
the production-only check and browser-host test sources have no type diagnostics.

## Follow-up: first image and stalled interactions

The follow-up review found more failure paths after the original audit:

| Cause | Correction |
| --- | --- |
| The first picture waited for encoder discovery/probes. | Deliver a JPEG first, then negotiate video. Separate source cursors from the monotonic display receipt across codec changes. |
| Sampling every other Chromium damage event missed isolated CSS hover/click updates. | Capture every damage event; pace video downstream. Reconcile missing updates with a bounded screenshot watchdog and suppress identical JPEGs. |
| A single fallback timer fired during navigation and never tried again; a screencast event before its start reply was dropped. | Give capture its own owner, serialized lifecycle and repeating reader-owned watchdog, accept current-start events and resume on navigation completion. |
| Concurrent reads passed the waiter check before either awaited start completed. | Admit only one read across its entire asynchronous lifetime, with owner-specific cancellation. |
| Lost local frame receipts retained display credit indefinitely. | Restart only that presentation after five seconds; ignore retired stream receipts. |
| Leaving the canvas left the remote element hovered. | Negotiate human-only pointer exit, preserving focus, held keys and drag capture. |
| Resizing published an epoch before incrementing the input generation, and overlapping layouts could abandon half-applied viewport metrics. | Publish generation with its epoch, serialize complete size/DPR updates, and gate capture/human/agent actions while applying. A real Chromium test reproduced the old generation remaining in the event feed. |
| An old successful input receipt could overwrite a newer driver generation. | Retain newer authoritative tab state; verify through the real Electron registration/preload with a deliberately held receipt. |

The new capture owner is `runtime-capture.ts`; the main codec/cursor owner is
`remote-frames.ts`. Existing HTTP/JPEG clients and older strict input hosts
retain their supported contracts. No dependency, page observation permission,
credential exposure or mutation replay was added. CDP semantics were checked
against the locked Playwright protocol types and the official
[Page protocol](https://chromedevtools.github.io/devtools-protocol/tot/Page/).

Verification: 73 browser-host tests (including real sandboxed Chromium hover
pixels, click delivery and hide/show), 183 desktop transport/runtime tests and
699 Angular renderer tests pass. Desktop lint/build, backend production
TypeScript, typed lint for the changed host modules, native Electron smoke and
the native delayed-input receipt regression pass. The standard scripts ran
through Node because the local pnpm launcher stalled. The native stream capture
report is `artifacts/desktop-capture/browser-stream-resilience-verified/report.json`
(`verified: true`, no errors/warnings); light/dark, narrow reduced-motion and
paused-display PNGs were inspected. This is local development verification;
external SSH/WAN latency, arbitrary sites and packaged/foreign-OS launches are
not established by these checks.
