# New Code workbench verification

## Panel loading and reopen regression — current verification

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
