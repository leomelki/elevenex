# New Code workbench verification

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
