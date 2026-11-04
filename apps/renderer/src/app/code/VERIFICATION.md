# New Code workbench verification

## Closing-edge compositor clipping

On 2026-11-04, added an explicit rounded clip to the shell panel so retained
Code iframe and snapshot layers remain confined through its final subpixel
widths. The existing native scenario now includes 270ms and 279ms closing frames.
`artifacts/desktop-capture/code-panel-flash/report.json` verified **83 checkpoints**
with no renderer errors using real Code OSS and an isolated disposable backend.
Inspected the final light/dark compact, wide and interrupted-expansion PNGs;
the right edge stays clear. Reopening, search, saving, focus and reduced motion
also passed. A separate shell capture verified 24 checkpoints in both themes.
`desktop:lint`, `desktop:test`, `desktop:build` and `git diff --check` passed
(158 desktop cases, seven capture cases and 647 renderer cases, plus type checks).
Verification used unpackaged macOS Electron; no packaged or other-OS launch.

## Softer transition blur

On 2026-11-04, reduced only the editor transition peak blur from 20px to 16px,
derived from existing tokens. Timing, opacity, scaling and panel retention are
unchanged. `desktop:lint`, `desktop:build` and `git diff --check` passed.
`artifacts/desktop-capture/code-softer-blur/report.json` verified **71 checkpoints**
with no renderer errors, including exact computed `blur(16px)` at light/dark
expand/collapse midpoints. Inspected those new PNGs. No new unit tests were added
or rerun for this CSS-only adjustment; behavior is covered by the native run.
Verification used unpackaged macOS, with an isolated backend stopped afterward.


## Retained contents during the closing slide

Verified on 2026-11-04 on macOS arm64 / Electron 45 with the real Code OSS
workbench and disposable Nest backend/task. The shell keeps outgoing contents
opaque at their existing inner width until its actual closing width transition
settles. `panelPresent` owns visual lifetime and `panelWide` retains the outgoing
feature layout. Code becomes inactive immediately, retains its mounted frame and
painted viewport through exit, then parks it after completion. Changes review
uses the same visual lifetime. Interrupted reopening cancels pending cleanup.

- `pnpm desktop:lint`, `pnpm desktop:test`, `pnpm desktop:build`: passed.
  Full suite: 158 desktop cases, seven capture cases, TypeScript contract checks,
  and 647 renderer cases in 94 files. Focused tests cover inert retained contents,
  wide layout, cancellation/reopening, frame parking, suspended measurement,
  disabled platform actions and Changes review retention/disposal.
- `artifacts/desktop-capture/code-closing-final/report.json`: **71 checkpoints,
  verified: true**, no renderer errors. Both themes retain visible Code at
  70/140/245ms of closing from compact, expanded and halfway-expanded states.
  The panel remains opaque and inert, the real child viewport and current
  transform stay unchanged, and the same iframe survives interrupted reopening.
  Inspected closing midpoint and late-frame PNGs from the actual renderer.
- Immediate opening, staged blur/crossfade during expand/collapse, one viewport
  resize, stable panes, search, auto-save, repeated reopening, focus and narrow
  reduced motion also passed. Closed contents are parked after the slide.
- `git diff --check`: passed. No dependencies, backend sources or bridge contracts
  changed. Verification used an unpackaged native macOS app; no packaged or
  Windows/Linux runtime launch was run. The owned disposable backend was stopped.


## Immediate panel opening and staged expand/collapse — current motion

Verified on 2026-11-04 on macOS arm64 / Electron 45 with the real Code OSS
workbench and disposable Nest backend/task. Ordinary opening/closing no longer
starts the resize fallback or covers the retained editor. Expand/collapse keeps
its 280ms shell glide and one early viewport resize. The 140ms visual transition
starts its blur one third into the shell clock, holds an opaque blurred midpoint
until the child acknowledges layout, then crossfades and clears the new image.

- `pnpm desktop:lint`, `pnpm desktop:test`, `pnpm desktop:build`: passed.
  Full suite: 158 desktop cases, seven capture cases, TypeScript contract checks,
  and 641 renderer cases in 94 files. Regression tests cover unchanged opening,
  interrupted reopening, shell-clock timing and the opaque midpoint hold.
- `artifacts/desktop-capture/code-instant-staged-verified/report.json`:
  **49 checkpoints, verified: true**, no renderer errors. Opening captures at
  90ms show the retained workbench with no cover or snapshot in both themes.
  Natural-frame probes observe first blur at **117–133ms** and first opacity
  blend at **183–200ms** of the 280ms glide on this host. These are observations,
  not a general rendering-performance guarantee.
- Both directions/themes retain exactly one child viewport resize and zero pane
  movement through reveal. Held acknowledgements remain opaque. Native keyboard
  input, toolbar hit testing, repeated reopening, interrupted width transitions,
  narrow/reduced motion, retained edits, search and auto-save passed. Inspected
  opening and halfway expanded PNGs from the actual renderer.
- `git diff --check`: passed. No dependencies, bridge contracts or security
  capabilities changed. The owned disposable backend was stopped. This verifies
  unpackaged macOS behavior; packaged and Windows/Linux launches were not run.


## Smooth panel glide with overlapping blur/crossfade (superseded)

Verified on 2026-11-04 on macOS arm64 / Electron 45 with the genuine Code OSS
workbench and isolated disposable Nest backend/task. Removed the snapshot's
shell-animation finish hook, preserving the original 280ms width and chat fade.
The iframe resizes once at the predicted destination; its outer compositor image
follows the panel edge while old/new layouts stretch and blend with a 200ms fade
and the 20px glass blur. A pre-capture timing regression keeps the outgoing image
fitted before the destination width is applied.

- `pnpm desktop:lint`, `pnpm desktop:test` and `pnpm desktop:build`: passed.
  Full suite: 158 desktop cases, seven capture cases, 639 renderer cases and
  TypeScript contract checks. Final focused Angular rerun: 13 cases passed.
- `artifacts/desktop-capture/code-glide-verified/report.json`: **47 checkpoints,
  verified: true**, no renderer errors. Natural frame probes require multiple
  intermediate panel widths and an active blurred blend during the glide in
  both directions/themes. Shell and image bounds match at scrubbed half-width
  frames; the iframe retains one destination viewport throughout.
- The child-layout acknowledgement hold, zero internal pane movement during
  reveal, native keyboard input, toolbar hit testing, interrupted reversals,
  repeated reopen, narrow/reduced motion, retained edits, search and auto-save
  passed. Inspected actual light/dark midpoint and settled PNGs.
- No dependencies, platform contracts or security capabilities changed.
  `git diff --check`: passed. Validation used an unpackaged native macOS app;
  no packaged-app or Windows/Linux launch was run.


## Immediate sizing and single blur/fade (superseded)

Verified on 2026-11-04 on macOS arm64 / Electron 45.0.0 with the genuine Code OSS
workbench and disposable Nest task/backend. The destination is predicted from
actual CSS keyframes and applied at the start. The old editor snapshot remains
visible while the incoming, directly named iframe renders. They blend in one
140ms blur/fade; there is no blank hide/show phase or fixed 120ms quiet delay.

- `pnpm desktop:lint`, `pnpm desktop:test`, `pnpm desktop:build`: passed.
  Full suite: 158 desktop cases, seven capture cases, 639 renderer cases in
  94 files and TypeScript contract checks. Tests cover early percentage sizing,
  layout commit ownership, context cleanup, viewport ordering and two stable
  child paints. Native `electron-smoke.cjs`: passed.
- `artifacts/desktop-capture/code-crossfade-ready/report.json`: **45 checkpoints,
  verified: true**, no renderer errors. Actual click-to-destination-resize readings
  are **33–61ms** across desktop/narrow widths and both themes. These are host
  observations, not a general performance guarantee. Each toggle resizes once.
- Native checks hold back the real layout acknowledgement and require the old
  snapshot to remain opaque. Toolbar hit testing and actual editor ArrowUp input
  still work. The 350ms pane probe records **zero movement through/after reveal**.
  Inspected old/new blend midpoints, incoming iframe opacity, natural image scale,
  both reversal directions, narrow/reduced motion and settled states. Search,
  settings layering, auto-save, retained buffers and repeated reopen still pass.
- No dependency or bridge capability was added. Browser-owned snapshots are not
  exposed as pixel data. `git diff --check`: passed. Unpackaged macOS verification;
  no packaged or Windows/Linux launch was run.

## Acknowledged hidden layout (superseded)

Verified on 2026-11-04 on macOS arm64 / Electron 45.0.0 with the actual Code OSS
workbench and isolated Nest task/backend. Transparent cross-origin frames were
throttled while upstream layout was still pending. An opaque cover now keeps Code
rendering underneath; the reveal waits for compact commands, the expected child
width and quiet pane geometry instead of two parent-window frames.

- `pnpm desktop:lint`, `pnpm desktop:test`, `pnpm desktop:build`: passed.
  Full suite: 156 desktop cases, seven capture cases and 636 renderer cases.
  The final focused security/layout suite also passed all seven cases, including
  bounded payloads, delayed geometry, cancellation/deadline cleanup and ignoring
  caret opacity animations. Renderer tests cover stale acknowledgements and
  failure recovery without permanently hiding writing.
- `artifacts/desktop-capture/code-layout-cover-first/report.json`: **35 checkpoints,
  verified: true**, no renderer errors. The real layout acknowledgement is held
  back to assert the cover remains opaque. A child-frame geometry probe requires
  **zero pane movement for 350ms through/after acknowledgement and reveal**, in
  both directions and both themes. Each toggle still resizes the iframe exactly
  once, fully covered. Inspected settled and interrupted PNGs. Existing retained
  edits, auto-save, search, focus, reopen and narrow/reduced-motion checks pass.
- Native `electron-smoke.cjs`: passed with the installed sandboxed Electron.
  `viewportWidth` is an optional, bounded presentation field; existing callers
  retain their defaults. No dependencies changed. `git diff --check`: passed.
  These are unpackaged macOS checks; no packaged or Windows/Linux launch ran.

## Natural-scale dissolve (superseded)

Verified on 2026-11-04 on macOS arm64 / Electron 45.0.0. Replaces the stretching
implementation below with a natural-scale dissolve. The editor resizes while
transparent, then fades in after two paint frames. Pending reveals are cancelled
on another transition, reduced-motion changes and teardown.

- `pnpm desktop:lint`, `pnpm desktop:test`, `pnpm desktop:build`: passed.
  The full renderer suite passed 632 cases; all six focused viewport cases passed
  after adding the first-frame layout-read regression.
- `artifacts/desktop-capture/code-dissolve-final/report.json`: **35 checkpoints,
  verified: true**, no renderer errors. Actual iframe resize observations assert
  **zero opacity and no transform** at each reflow, with exactly one viewport
  resize per toggle in both themes. Inspected settled and interrupted PNGs.
  Both reversal directions, repeated reopen, retained writing, real auto-save,
  search, focus and narrow reduced motion pass.
- `git diff --check`: passed. No dependencies or platform contracts changed.
  These are unpackaged macOS checks; no packaged or Windows/Linux launch ran.

## Expand/collapse viewport motion

Verified on 2026-11-04 on macOS arm64 / Electron 45.0.0 with the real Code OSS
workbench and a disposable Nest task/backend.

- `pnpm desktop:lint`, `pnpm desktop:test` and `pnpm desktop:build`: passed.
  Tests include 154 desktop cases, seven capture cases and 631 renderer cases
  in 94 files, plus TypeScript contract checks. New tests cover frozen layout,
  cancellation/reversal, live window resizing, reduced-motion changes and cleanup.
- `artifacts/desktop-capture/code-motion-verified/report.json`: **35 checkpoints,
  verified: true**, no renderer errors. Inspected light/dark settled and midpoint
  images, plus narrow reduced motion. The actual child viewport changes exactly
  once per toggle: **432 → 1,072 px**, then **1,072 → 432 px**, in both themes.
  These are resize counts, not an FPS benchmark. Both midpoint reversal
  directions, six close/reopen cycles, frame identity, final panel/iframe/editor
  width agreement, search, focus, retained edits and real auto-save pass.
- Existing component preview opened successfully using the warm server on 4310.
  `git diff --check`: passed. No dependencies, bridge or backend contracts changed.
  This is unpackaged macOS verification; no packaged or Windows/Linux launch ran.

## Find file target size and spacing

Verified on 2026-11-04 on macOS arm64 / Electron 45.0.0. The native Find file
action now fills the available left header space, with a 30px-high target, 8px
inner padding, separation from New File, and a quiet hover/focus surface.

- `pnpm desktop:lint`, `pnpm desktop:test`, `pnpm desktop:build` and native
  `electron-smoke.cjs`: passed. No dependencies or platform contracts changed.
- `artifacts/desktop-capture/code-find-target-verified/report.json`:
  **30 checkpoints, verified: true**, no renderer errors. Inspected default,
  hover and keyboard focus in both themes, plus narrow/reduced-motion layout.
  Geometry checks assert target height/width, center alignment and an 8px minimum
  gap before New File. Native clicks near the bottom-right padded edge open
  Quick Open. Actual Tab/arrow navigation and Enter activation also pass.
- `git diff --check`: passed. These are unpackaged macOS checks; no packaged or
  Windows/Linux launch was run.

## Native compact Find file action

Verified on 2026-11-04 on macOS arm64 / Electron 45.0.0 with Code OSS
1.144.0. **Find file…** replaces `/` at the left of the compact file-tree header.
New File/New Folder remain at the right. The existing native `view/title` action
opens upstream Quick Open; scoped CSS presents it as a text action in the title
position. The separate shell icon and additional search row are removed.

- `pnpm desktop:lint`, `pnpm desktop:test`, `pnpm desktop:build`: passed.
  Tests include 154 main cases, seven capture-tool cases, IPC/shared type checks
  and 627 renderer cases. The extension regression exercises the registered
  native command and confirms it opens Quick Open without writing files. Focus
  tests verify that the compact presentation class is removed on acceptance and
  disposal. Compact Enter bindings also require list focus.
- `artifacts/desktop-capture/code-title-find-settled/report.json`:
  **28 checkpoints, verified: true**, no renderer errors. Inspected the native
  header, keyboard focus and Quick Open in both themes, plus narrow/reduced-motion
  layout. Real input verifies mouse/Enter activation, cancelling back to Files,
  result acceptance, tree navigation, retained edits, expansion/reopen and modals.
  The scenario asserts Find file occupies the left title position, `/` is hidden,
  no shell search row exists, and expansion removes the compact presentation.
  Its disposable setup reselects the backend to refresh stale startup scope,
  publishes a new machine revision and awaits onboarding. Header keyboard checks
  wait for Browse to finish focusing the tree before moving focus to the action;
  this avoids a late native tree-focus command consuming the test's Enter.
- Native `electron-smoke.cjs`: passed. The existing cross-origin iframe sandbox
  advisory remains in captures; no security settings or contracts changed.
- `git diff --check`: passed. No dependencies changed. These are unpackaged
  macOS checks; no packaged or Windows/Linux launch was run.

## Auto-save and native save alerts — current verification

Verified on 2026-11-03 on macOS arm64 / Electron 45.0.0 with Code OSS
1.144.0. Files use upstream delayed auto-save (1,000 ms); the shell Save
button is removed without adding a header status or replacement action.

- `pnpm desktop:lint`, `pnpm desktop:test`, `pnpm desktop:build`: passed.
  Tests include 153 main/security/process cases, seven capture-tool cases,
  IPC/shared TypeScript assertions and 627 renderer cases in 93 files.
- Native `electron-smoke.cjs`: passed. `code-workbench-smoke.cjs`: passed
  against a disposable git worktree. Typing reaches disk without a save action;
  a rejected auto-save displays a visible upstream **Failed to save** toast
  with Retry, Save As and Revert, retains the dirty buffer and leaves disk
  unchanged. The smoke deliberately toggles auto-save off only for its existing
  hot-exit/crash recovery case. Inspected `artifacts/code-autosave-failure.png`.
- `artifacts/desktop-capture/code-autosave-verified/report.json`: **28 states**,
  `verified: true`, no errors. Inspected light/dark compact panels, expanded
  editing and the saved result. The real isolated backend/task capture checks
  auto-save through resize/tab switching, no shell Save button, keyboard focus,
  interrupted transitions, reduced motion and narrow/closed layouts.

The host checks require permission to bind loopback sockets and launch native
workers/Electron; initial sandbox attempts could not do so and were rerun on
the host. Capture setup used the installed declared Express package through
`NODE_PATH` and an isolated runtime directory/database. No dependency or
lockfile changes. This follow-up does not add physical remote-host or packaged
runtime verification.

## Compact Files browsing — current verification

Verified on 2026-11-03 on macOS arm64 / Electron 45.0.0 with the same pinned
Code OSS 1.144.0 runtime. No dependency or backend endpoint changes.

The compact panel shows the native file tree when empty. Browse files temporarily
uses the full Code area without closing editors; single-click/Enter accepts a
file, including the already active one. Back/Escape returns to retained writing.
Expanding moves the same native file view back to Explorer. A local Back intent
remains available offline; reads and mutations still require a live backend scope.

- `pnpm desktop:lint`, `pnpm desktop:test`, `pnpm desktop:build`: passed. Tests
  include 153 main/security/process cases, seven capture-tool cases, IPC/shared
  TypeScript assertions and 627 renderer cases in 93 files. New coverage checks
  compact preference restoration, empty/editor transitions, subscriptions,
  click/focus cleanup, presentation lease/shape validation and Files/Back intent.
- `artifacts/desktop-capture/code-files-verified/report.json`: **28 checkpoints**,
  `verified: true`, no errors. Inspected both themes’ initial tree, full-width
  Files/Back surface and accepted-file states. Real mouse and keyboard acceptance,
  Escape, closing the last editor, expanded Explorer, dirty saves, tab switching,
  modal stacking, repeated reopen/resize, interrupted motion and narrow/reduced
  motion retain their production checks. The test-only adapter holds bootstrap
  and supplies an actual disposable Nest task/backend; no product test hook exists.
- Native `code-workbench-smoke.cjs --large`: passed on 12,001 files, including
  exact saved bytes, retained reopen, forced crash and dirty-buffer recovery.
  Warm artifact cache: usable file 1,833 ms, reopen 1 ms, crash recovery 1,016 ms
  on this Apple M1. These are single smoke measurements, not percentile claims.
- Native `electron-smoke.cjs` and production `code-window-smoke.cjs`: passed.
  The latter restores unsaved writing in another window and saves after the
  original closes, using an independent backend scope.
- Own extension resources now use `/extension-v2/` with `no-store`, escaping old
  immutable responses without changing task storage IDs. Tests verify the new
  route/cache policy; the previous path remains a compatible alias. Upstream
  artifact resources retain immutable caching.
- `git diff --check`: passed. No packaged launch, Windows/Linux UI or live SSH
  verification is claimed for this change.


## Panel loading and reopen regression baseline

Verified on 2026-11-03, macOS arm64 / Electron 45.0.0. Document loading and
editor readiness are now separate UI states: once the frame resource exists,
only the iframe owns the editor area. The native 320×160 size gate and Expand
placeholder are removed; layout width is measured without visual transforms.

The right margin reproduced as a **59.5 px horizontal scroll offset** on the
machine launch wrapper, shifting the entire workspace left. Its enlarged hidden
Home animation contributed to that scroll area. The wrapper now clips without
scrolling; Home retains its own scroll container.

- `pnpm desktop:lint`, `pnpm desktop:test`, `pnpm desktop:build`: passed. The
  renderer suite contains 626 cases in 93 files, including loading/ready frame
  exclusivity, transient zero/small sizes and reopening a cleared task selection.
- Production capture `artifacts/desktop-capture/code-panel-layout-confirmed/`
  contains **19 checkpoints**, with `report.json` reporting `verified: true` and
  no errors. Inspected loading, reopened, interrupted and narrow PNGs.
- A capture-only barrier holds real extension bootstrap to verify that loading
  has no launch card beneath the iframe. The disposable backend adapter keeps
  readiness events consistent with its external backend throughout the run.
- Six close/reopen cycles plus expand/collapse and interrupted 80 ms expansions
  cover both themes. Assertions require the launch scroll offset to remain zero,
  shell edges to match the launch viewport, iframe/workbench widths to agree
  after resize and the same frame identity to remain mounted. Existing search,
  toolbar save, dirty-text retention, modal stacking and narrow/reduced-motion
  checks still pass.

This is native unpackaged renderer verification, not a new packaged-app or
Windows/Linux launch. Earlier migration checks below describe that baseline.


## Iframe migration baseline

Verified on 2026-11-03 on macOS arm64 with Electron 45.0.0 / Chromium 156,
using the unmodified pinned Code OSS 1.144.0 web artifact. No dependency or
lockfile changes.

- `pnpm desktop:lint`, `pnpm desktop:test`, `pnpm desktop:build`: passed. Tests
  include 149 main/preload/security/process cases, seven capture-tool cases,
  shared/IPC TypeScript assertions and 623 renderer cases in 93 files.
- Native `electron-smoke.cjs`: passed with the final preload/presentation API,
  production `app://` routing/CSP, scoped IPC, theme and multiwindow lifecycle.
  Its backend is a controlled fixture.
- Native `code-workbench-smoke.cjs --large`: passed against a disposable git
  worktree with **12,001 files**, actual filesystem/search modules and real Code
  OSS. Verified text input, exact saved bytes, Quick Open/Quick Search, compact
  layout, same-frame reopen, forced renderer crash, dirty hot-exit restoration and recovered save. The frame
  cannot read the parent DOM or access Node/the application bridge; external
  fetch is blocked by CSP. This uses a focused HTTP adapter, not a full Nest app.
- Native `code-window-smoke.cjs`: passed against the actual disposable Nest
  backend. Unsaved source text is restored in a new iframe/window, its backend
  scope differs, and saving still works after the source window closes.
- Production capture: **14 checkpoints**, `verified: true`, no errors in
  `artifacts/desktop-capture/code-iframe-verified/report.json`. Inspected PNGs
  cover light/dark compact editing and pickers, settings painting above the live
  editor, dirty text retained through expansion and Browser/Code tab switching,
  actual toolbar saving, narrow reduced motion and hidden-panel focus.
- `pnpm desktop:preview` plus a native gallery shell capture: passed. This is a
  gallery smoke check, separate from the production editor evidence above.
- `git diff --check`: passed.

Warm artifact-cache measurements from the 12,001-file native regression on this
Apple M1: artifact validation 3 ms, usable file 1,689 ms, retained reopen 2 ms,
forced-crash restore 983 ms, filename search cold/warm 28/3 ms, first text-search
page 12 ms. These are individual smoke measurements, not percentile benchmarks.
The first-ever artifact download is unchanged and was not rebenchmarked here.

The capture records Chromium’s generic warning about combining `allow-scripts`
and `allow-same-origin`. The editor is cross-origin from the shell, cannot access
its parent DOM or remove its outer sandbox, and needs a real origin for workers
and durable IndexedDB. Both boundaries are enforced independently by CSP and
main-owned routing. The iframe has no popups, forms, downloads or top navigation.

The earlier native-editor partitions remain untouched. Their development-profile
browser storage is not imported into the new task/machine iframe origins; save
existing native-editor writing before restarting into this build. Current iframe
tabs and unsaved text survive in-window switching and the tested window handoff.
This migration has not been packaged or run on Windows/Linux or against a live
SSH backend. Earlier packaged/native-view evidence below is historical.

## Previous native-surface baseline (historical)


Verified on 2026-11-03, macOS 26.3 / Apple M1 arm64, Electron 45.0.0,
Chromium 156.0.8078.48, embedded Node 24.22.0 (CLI Node 24.22.1).
No previous editor sources, deleted-code diffs, bundles, tests or history were
used. No direct dependency or lockfile changes are part of this implementation.

## Checks

- `pnpm desktop:lint`: passed.
- `pnpm desktop:test`: passed, 146 main/preload/security/process tests, seven
  capture-tool tests, shared/IPC TypeScript checks and 620 renderer tests in 92 files.
- `pnpm desktop:build`: passed, including the separate web extension and notices.
- `pnpm --dir apps/backend build`: passed.
- `pnpm --dir apps/backend exec tsc -p tsconfig.build.json --noEmit`: passed.
- Backend Jest `--runInBand --runTestsByPath` for the four new Code spec files:
  18 passed. Real files, git worktrees/branch changes, ripgrep, directory watches,
  pagination, cancellation, readonly permissions, symlink rejection and revision
  conflicts are exercised. The broad backend `tsc --noEmit` additionally includes
  unrelated specs and fails with 146 errors outside `code-workspace`; it is not a
  passing check.
- Installed Electron `apps/desktop/test/electron-smoke.cjs`: passed with
  `ELECTRON_RUN_AS_NODE` unset. Real sandboxed preload, protocol/CSP, IPC validation,
  multiple windows, theme and backend lifecycle; backend responses are controlled.
- `code-workbench-smoke.cjs --large [--cold-install]`: passed. Real disposable git
  worktree, actual unmodified Code OSS, native text input and save, exact saved
  bytes, same-workbench reopen, forced renderer crash, restored dirty hot-exit
  buffer and exact recovered save. Its HTTP adapter supplies task metadata while
  using the actual new filesystem/search modules. It is not full-backend evidence.
- `code-window-smoke.cjs`: passed against the actual disposable Nest backend and
  task worktree. It uses production main/preload/router, reuses the original native
  workbench, verifies independent backend scopes, closes the parent and saves exact
  bytes through the detached editor. The probe file is restored afterward.
- Actual Nest HTTP checks: authorized descriptor/read/create/rename/delete/search,
  external revision conflict, stale generation, foreign origin, missing capability,
  traversal, Git metadata and symlink denial passed on a disposable ready task.
- `pnpm desktop:package --dir`: built an unsigned macOS arm64 application. ASAR
  includes the extension, tokens, license and local fonts. The packaged shell
  launched through `app://` with its real isolated bridge. Its backend release
  is unpublished (HTTP 404), so a packaged live editor was **not** established.
- `git diff --check`: passed. No merge, push or task finish was performed.

## Measured large fixture

The native smoke creates a repository containing 120 directories × 100 TypeScript
files plus `hello.ts`, commits it and allocates a separate git worktree. Cold means
a new empty artifact directory with an actual HTTPS download, digest verification
and extraction. Warm means a verified cache with a new browser profile; reopen
means retaining the same loaded native workbench. These are individual runs on a
shared development host, not throughput guarantees or percentiles.

| Measurement | Cold artifact run | Warm artifact run |
| --- | ---: | ---: |
| Artifact ready | 3,746 ms | 3 ms |
| File usable from startup | 5,983 ms | 2,167 ms |
| Retained workbench reopen | 3 ms | 5 ms |
| Dirty crash recovery | 21,070 ms | 24,895 ms |
| First filename query | 18 ms | 19 ms |
| Next filename query, reused index | 3 ms | 3 ms |
| First full-text result page | 8 ms | 7 ms |

Warm post-recovery working sets: workbench renderer 653 MiB (peak 683 MiB),
browser/main 270 MiB, GPU 102 MiB, utility 42 MiB and test host renderer 83 MiB.
These include the TypeScript language service on 12,001 files. No native editor
server process is launched. Crash recovery is noticeably slower than ordinary
reopen; heavy language-service memory is a real remaining performance cost.

Raw runs: [cold metrics](../../../../../artifacts/code-workbench-cold-metrics.json),
[warm metrics](../../../../../artifacts/code-workbench-warm-metrics.json).
Reproduce after backend/desktop builds with the installed Electron:

```sh
env -u ELECTRON_RUN_AS_NODE ELEVENEX_CODE_SMOKE_CACHE=/tmp/elevenex-code-cache \
  apps/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron \
  apps/desktop/test/code-workbench-smoke.cjs --large
# Add --cold-install for an isolated fresh download instead of that cache.
```

## Live visual evidence

The checked-in `scripts/desktop-capture/scenarios/task-code-live.mjs` drives a real
local backend, selected project/task/session and production renderer. It verifies
compact and expanded panels, both themes, line-seven opening, genuine Quick Open,
full-text search after a stale query, narrow/reduced-motion layout and inert closed
panel. Native child pixels are captured separately at their actual live bounds;
DOM/accessibility diagnostics describe the shell. New PNGs were inspected.

[Final capture report](../../../../../artifacts/desktop-capture/task-code-final/report.json)
must have `verified: true` and no renderer errors. The separate capture-tool
fixture regression also passed; it is not product evidence.

Set `ELEVENEX_CODE_CAPTURE_PROJECT`, `ELEVENEX_CODE_CAPTURE_TASK` and
`ELEVENEX_CODE_CAPTURE_SESSION` to explicit **disposable** live resource IDs. Supply
a `src/workspace.ts` with at least seven lines, a `README.md` and the function name
`describeWorkspace`. Optionally set `ELEVENEX_CODE_SMOKE_CACHE` to the verified
cache root containing `1.144.0`. Run:

```sh
pnpm desktop:capture scripts/desktop-capture/scenarios/task-code-live.mjs --built
```

The detached smoke additionally requires `ELEVENEX_CODE_TEST_TASK_ID` and
`ELEVENEX_CODE_TEST_WORKSPACE`, plus the same verified cache root. Configure the
normal documented development backend override to target the disposable backend;
there are no production test hooks. Never point this write probe at valuable work.

## Remaining verification and limits

### UI review follow-up

The follow-up UX pass was exercised with `ELEVENEX_CODE_CAPTURE_UX=1` using the
same checked-in live scenario, real backend and disposable task. The
[final UI report](../../../../../artifacts/desktop-capture/code-ux-verified/report.json)
records 16 verified states with no renderer errors; the separate
[editor-window report](../../../../../artifacts/desktop-capture/code-ux-verified/code-editor-window-report.json)
also verifies the actual native child, reused workbench, healthy Explorer and
machine-menu isolation. New PNGs were inspected in both themes.

At the same 1440 × 900 viewport, workbench height increased from 696px to 752px
(56px / 8.0%) by consolidating task identity and status into one toolbar. The
review covers interrupted/reversed expansion, a toolbar tooltip that leaves the
editor visible, keyboard Focus editor and return-to-chat, stable behavior near
the 600px native minimum, direct narrow-window launch, short-window keyboard
access, retained state after closing the editor window and inert closed panels.
The destination Explorer must show actual task files without a capture-script
refresh, and its reconciliation must preserve editor focus. The final native
window smoke separately confirms exact saving after the parent closes.

Keyboard dispatch and editor focus are checked through native Chromium input,
DOM focus and typed IPC handoff. macOS foreground activation is not asserted;
the shared capture environment does not reliably activate the test application.
This UI pass does not expand the physical remote/platform coverage below.

### Platform and recovery coverage

The subsequent title-row removal passed `desktop:lint`, `desktop:test`, and
`desktop:build`. [New live captures](../../../../../artifacts/desktop-capture/code-no-titlebar/report.json)
verify 16 states and both themes, with zero renderer errors. The native title-bar
rectangle has zero height and the editor part starts within 8px of the workbench
top; the same zero-height assertion passes in the separate window. The new PNGs
were inspected. This uses upstream layout settings without changing runtime assets.

No physical SSH machine or Windows/Linux host was available. The Code transport
uses the existing authenticated SSH Unix-socket client, whose local integration
suite covers loss/reconnect/cleanup; actual remote Code behavior still requires a
host run. Signing/notarization and packaged live editing need a published matching
backend release. They are not implied by successful packaging or native smoke.

Interrupted save/conflict recovery is checked through the real compiled extension
provider with controlled durable storage/transport failures; arbitrary network
cuts during a native editor save have not been exhaustively fault-injected.
Rapid selection and stale replies are covered by stores and transport tests;
all combinations of task finish/reallocation and multiple live editor windows
have not been exercised natively.

The feature rejects symlinks and validates task roots/paths on each operation. Node
pathname checks and compare-before-rename saves are not an OS filesystem sandbox
or a transaction against malicious concurrent directory replacement/external
writers. Strong adversarial filesystem-race isolation remains a limitation.
Files over 8 MiB, symlinks, recursive nonempty-folder deletion, native extensions,
terminals/debuggers and arbitrary webviews are intentionally unsupported; other
resource/result limits are documented in the feature guide.

## Compact side-panel editing (2026-11-03)

The normal 440px Code panel now mounts the real editor at about 432px usable
width, alongside chat, with direct Find file / Search text / Save controls.
Compact mode hides sidebar/activity bars and wraps code; expansion restores
Explorer and the saved settings without replacing the workbench. The accepted
4px gutters remain uniform.

Passed for this change:

- `pnpm desktop:lint`, `pnpm desktop:build` and `pnpm desktop:test` (146 desktop
  tests, seven capture-tool tests, shared/IPC TypeScript checks and 620 renderer
  tests). The host's installed pnpm initially tried network resolution; validation
  used the already-installed workspace-pinned pnpm 8.15.4. Socket/native checks
  ran with the required host access after sandbox EPERM/native-worker failures.
- New presentation regression: exact preference restoration across an extension
  restart and no repeated configuration writes within the same size mode.
  Renderer tests cover compact auto-open, three fixed intents, layout retention,
  hidden-panel rejection, teardown and stale focus acknowledgements. Main validates
  the action allowlist and requires a visible owned workbench and current scope.
- Extended `code-workbench-smoke.cjs`: real sandboxed Code OSS in a disposable
  worktree, 432px compact layout, native file/text search, same-view expansion,
  save, crash/hot-exit restoration and toolbar-equivalent explicit saving passed.
  Its backend adapter uses the real filesystem/search modules.
- Installed-Electron `electron-smoke.cjs` passed with the exact updated preload
  surface. This is an unpackaged native check, not a packaged release launch.
- `task-code-compact.mjs --built`: **10 states, verified: true**, no renderer
  errors. Actual disposable Nest backend and task, production UI/IPC/transport,
  both themes, visible native Quick Open/Quick Search, opening a result, exact
  toolbar-saved bytes, dirty-file retention in both layout directions, narrow
  reduced motion and hidden native surface. The fixture file is restored. The
  capture-only backend-manager adapter points to the fixture process without
  touching the user's managed backend. Native focus emulation keeps pickers open
  during screenshot diagnostics.
- Updated existing `task-code-live.mjs` UX suite: **16 states, verified: true**,
  no renderer errors, plus its verified detached-window/menu report. This covers
  interrupted expansion/reversal, themes, native search, width stability,
  tooltips, keyboard focus/return, narrow/short windows, separate-window handoff
  and closing. The startup wait selects the project before waiting for its tasks.
- New PNGs were inspected, including compact editing/search, confirmed save,
  narrow layout, interrupted expansion and expanded editing. Reports/images:
  `artifacts/desktop-capture/code-side-panel-verified/` and
  `artifacts/desktop-capture/code-side-full-regression-2/`.
- `git diff --check` passed; no dependencies, lockfiles or backend sources changed.

Remote-host and packaged-live-editor coverage remains as recorded above; this
UI change does not establish additional verification of either.

## Removed redundant task toolbar (2026-11-03)

Removed the entire task-name / branch / connection-status / focus toolbar in
compact, expanded and standalone Code views. The workbench now follows the
existing panel-tabs row immediately, with the same uniform 4px gutters. File,
text-search, save and separate-window controls project into that existing row via
`CodePanel.actions` / `WorkspacePanels.codeActions`; focus and recovery ownership
remain in CodePanel. Native status feedback and exceptional recovery banners remain.

`desktop:lint`, `desktop:test` (620 renderer tests) and `desktop:build` passed.
The real disposable Nest-backed `task-code-compact.mjs --built` run captured
10 states with `verified: true` and no renderer errors, including both themes,
compact/expanded views, native file/text search, retained dirty file, exact saved
bytes, narrow/reduced motion and closed-panel state. PNGs in
`artifacts/desktop-capture/code-without-toolbar/` were inspected. The test fixture
file was restored and the owned backend was stopped. Existing native smoke and
full UX capture consumers were updated to use loaded native surfaces and the
relocated controls instead of depending on the removed toolbar.

No backend, dependencies or lockfiles changed for this follow-up.

Save is now the shared icon button with a named 16px `save` glyph, an accessible
label and platform shortcut tooltip. Command/Ctrl-S remains available. Lint,
production build and all four focused Code panel tests passed. The live
`code-save-icon-checked` report verified 12 states with no renderer errors,
including inspected light/dark icon/focus/tooltip PNGs and exact bytes saved
through the icon. The obsolete disposable backend fixture was rebuilt from the
current checkout and launched with its required capability; it was stopped after
verification. No backend sources, dependencies or lockfiles changed.

## Fullscreen Code navigation

Run and Debug and Extensions navigation buttons are hidden in the shared
workbench document; Explorer, Search and Source Control remain visible. Native
`task-code-compact.mjs --built` verification passed with 31 checkpoints,
`verified: true` and no renderer errors. The light/dark expanded PNGs in
`artifacts/desktop-capture/code-navigation-verified/` were inspected, and the
scenario now asserts the five navigation items explicitly. Compact Files,
search, auto-save and retained-frame resizing also passed.

`desktop:lint`, `desktop:test` (627 renderer tests), `desktop:build` and the
unpackaged Electron smoke passed. Capture used a disposable local backend/task;
its file was restored and the owned backend was stopped. This does not establish
packaged-app or SSH runtime verification. No dependencies or backend sources changed.
