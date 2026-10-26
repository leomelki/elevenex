# Component system verification

## Machine editing and removal, 2026-10-26

Imported the next archive's changed specifications after reading CHANGES.md.
The production Home now exposes card menus, retained edit/remove dialogs,
persisted appearance and SSH settings, reconnect-on-save and removal with Undo.
No dependencies or tokens changed; unrelated customized specifications remain.

Passed desktop lint, the desktop test command (91 main/security/lifecycle tests,
7 capture-tool tests and IPC type checking), the final Angular run (238 tests),
renderer type checking and desktop production build. The native Electron smoke
passes with the real sandboxed preload, local appearance mutation, invalid-payload
rejection, saved-host removal/Undo and restrictive app:// security. Its backend
remains a controlled test runtime; this is an unpackaged smoke, not a packaged
application or real external-server verification.

Native reports, all verified with zero errors/warnings:

| Capture | Checkpoints | Scope |
| --- | --- | --- |
| machine-editing-motion-check | 32 | Both themes, hover/focus menu, keyboard/Escape restoration, right-click placement, anchored dialog frames, name/color/host/port edits, preparation only on Home, instant removal/Undo, occupied confirmation/removal, focus after opener removal, narrow local editing and reduced motion |
| machine-editing-final-launch | 22 | Existing launch, interrupted/reopened launch and anchored modal transitions/focus in both themes after the card wrapper and modal fallback changes |
| machine-editing-startup-regression | 16 | Existing production startup, trust/sign-in, connection recovery, errors, stable selection geometry, narrow layouts and reduced motion |

Reports live under `artifacts/desktop-capture/<capture>/report.json`.
The machine editing regression samples actual frames: a 260ms card fade is
followed by the surviving neighbour travelling 182.5px with intermediate positions
in both themes. It also checks that Undo restores machine IDs/order without a
connection or pending launch. New light/dark modal, menu, removal/Undo and narrow
PNGs were inspected. Local keyboard focus returns to Home even if the deleted
opener remains mounted but inert for its fade. A held right-click is completed
before the menu opens, preventing the opening auxclick from dismissing it.

Native SSH integration tests cover two-window appearance edits without reconnect,
changed-destination reconnect, occupied removal returning both windows to Home,
and restoration of the same host at the original index without connecting.
Unit regressions cover failed writes, preserved SSH key choices, window-owned
single-use Undo tokens, bounded retention, timer/listener cleanup and toast
activation/expiry. The production transport still supports local/SSH only;
peer Edit/Unpair presentation and the existing OpenSSH trust boundary are
explained in the machine application guide.

## Stable Home during machine selection, 2026-10-26

Removed Home's bottom pending-opening notice and Cancel opening button. The
machine card and title island display preparation status without shrinking the
available Home area or shifting the centered grid.

`artifacts/desktop-capture/machine-selection-stable/report.json` is `verified: true`
with 16 checkpoints and zero errors/warnings. The production startup regression
now compares Home and every card's position and size before/after local selection,
remote retry in dark mode, and remote selection at 480px with reduced motion.
All geometry remains within 0.05px. Light and narrow dark PNGs were inspected.

## Failure-card shake correction, 2026-10-26

Corrected the failure shake's timing: WAAPI easing now applies between keyframes,
as in the reference CSS, instead of easing the complete sequence and compressing
most movement into the opening frames. The native regression now asserts actual
card translations, rather than only capturing the animation.

`artifacts/desktop-capture/failure-shake-fixed/report.json` is `verified: true`:
43 checkpoints, zero errors and the five existing preview draft-reset warnings.
In both themes, the card measures exactly 0px at 0ms, −3px at 84ms, +3px at 189ms,
−1.5px at 294ms and 0px at 420ms. Representative PNGs were inspected. Unit tests
cover no shake on first-paint errors, one shake per failed preparation, no replay
on error-text updates, retry cancellation, reduced motion and disposal.

Passed `pnpm desktop:lint`, `pnpm desktop:test` (225 renderer tests, 84 desktop
tests, seven capture-tool tests and contract type checks), `pnpm desktop:build`
and `git diff --check`. Native verification remains unpackaged macOS with the
production machine owner and isolated preview platform adapter.

## Project and machine design update, 2026-10-26

Imported the archive changelog, seven changed component specifications, brand
book, design index and reference type declarations. Tokens, dependencies,
lockfiles, legacy app and IPC contracts are unchanged.

Passed `pnpm desktop:lint`, `pnpm desktop:test` (224 renderer tests in 47 files,
84 main/preload/security/SSH tests, seven capture-tool tests and IPC `tsc` checks),
`pnpm desktop:build` and `git diff --check`. Used cached pnpm 8.15.4; host execution
was needed for native Electron and loopback fixtures. Port 4310 belongs to another
checkout; this checkout's preview ran on 4311 and was stopped after verification.

Native reports under `artifacts/desktop-capture/`:

- `design-oct26-verified/report.json`: `verified: true`, 41 checkpoints, zero errors.
  Five Angular NG0956 warnings come from deliberate version-key draft resets in
  the preview. Captures cover both themes, failure nudges and stopped progress,
  retry, safety errors, retained errors after machine changes, repeated island
  pings, Back, Find/focus, narrow reduced motion, anchored modal entry, plain
  Create exit, later-project rail pop/ring and cancellation/focus restoration.
- `design-oct26-startup/report.json`: `verified: true`, 14 checkpoints, zero
  errors/warnings. The existing production startup regression still passes,
  including preparation, launch, SSH trust/sign-in, recovery, updates and narrow
  dialogs with Escape/focus restoration.

Representative light/dark error and project insertion PNGs were inspected.
Measured safety card action contrast is 5.82:1 (light) / 7.02:1 (dark); its border
contrast is 5.33:1 / 6.80:1. Unit coverage also includes optional action fallback,
Find keyboard behavior, failure progress/retention, add-tile identity and clearing
or reopening a modal origin during exit. No capture fixture is product evidence.

This is native unpackaged macOS verification with an isolated platform adapter
for the production machine owner. The existing desktop project adapter remains
pending: later creation is exercised through the real components in `/projects`.
Packaging, a packaged-app launch, external SSH servers and release downloads were
not part of this design update.

## Production startup and machine integration, 2026-10-25

The normal lazy route now composes the designed machine components with the real
local/SSH lifecycle. Main owns ordered window snapshots, saved-host presence,
validated window creation and atomic first-run completion. Renderer owners keep
drafts, launch intent, cancellation, preparation and modal state separate from
the reusable components. See [the integration boundaries](src/app/machines/application/README.md).

Passed `pnpm desktop:lint`, `pnpm desktop:test` (216 renderer tests in 46 files,
84 main/preload/security/SSH tests, seven capture-tool tests and IPC `tsc` checks),
`pnpm desktop:build`, the installed Electron native smoke and `git diff --check`.
Used Node 24.22.1 and cached pnpm 8.15.4. The build/test processes required host
access because the filesystem sandbox blocks loopback listeners and aborts the
Angular build. No dependencies or lockfiles changed.

`artifacts/desktop-capture/startup-final-states/report.json` is `verified: true`
with 14 checkpoints and no errors/warnings. Representative PNGs were inspected.
The saved `machine-startup.mjs` scenario checks the **production composition**
with its isolated preview platform: first run, pending readiness, launch/return,
open-machine updates, SSH destination validation, actual trust/credential UI,
recovery/failure, both themes, narrow layouts, reduced motion and Escape/focus
restoration. It waits for the real inert boundary and settled animation geometry.
Fixtures remain outside the production entry; `--fixture` was not used.

The native smoke exercises real main/preload IPC, first-run persistence, scope
invalidation, native theme, multiple windows and restrictive `app://` routing/CSP.
Its engine is an isolated backend fixture. The existing SSH suite uses real
loopback OpenSSH with fixture runtimes; no live external server or release
download was claimed. Packaging and packaged-app launch were not performed.

Current feature limits are explicit in the product: peer transport is unavailable,
and the designed NewProject landing is disabled until the scoped project adapter
is implemented. Neither path simulates success or submits unusable data. Ordinary
windows open passive Home; returning Home retains the selected connection.

## Anchored modal launch motion, 2026-10-25 ZIP

Compared all archive files against the previous committed ZIP: 7 changed, none
added or removed. Imported the changed brand book, AddMachine/Sheet specifications
and design index verbatim. Tokens, dependencies, IPC and the legacy app are unchanged.

Anchored modals now use the supplied launch curve and times (560ms open, 500ms
close): a travelling clipped box, uniformly scaled dialog content, fading source
face and a separate following shadow. Geometry/keyframes and animation ownership
are separate from the Angular portal/focus lifecycle. WAAPI runs the frames;
application code measures at transition boundaries, without a per-frame loop.
Exit presence follows animation completion instead of a fixed cleanup timer.

Regression work also corrected component CSS overriding the copied face's position,
opacity discontinuities on rapid reversals, stale AutoHeight measurements across
reused portals, and focus falling onto the page when an ordinary sheet reopened
during its exit. Return destinations exclude in-progress entry/recession transforms;
replacement faces stay inert and have no duplicate IDs or machine/list identities.

Passed `pnpm desktop:lint`, `pnpm desktop:test` (158 renderer tests in 39 files,
IPC negative-type checks, 4 preload/security and 7 capture-tool tests), preview
TypeScript, `pnpm desktop:build`, and `git diff --check`. Used the cached pinned
pnpm 8.15.4 with Node 24.22.1. The production build passed on the host; Angular's
sandboxed production build aborted with SIGABRT.

Final native reports under `artifacts/desktop-capture/`:

| Directory | Captures | Coverage |
| --- | ---: | --- |
| `oct25-dialog-verified` | 42 | SSH/pair card and footer origins, uniform cover fit, all-layer continuity in both reversal directions, returning into the current card, replacement faces, keyboard/focus, reduced motion initially and during entry, both themes |
| `oct25-onboarding` | 40 | Full SSH/key/pair preparation and machine flows, error/disabled/empty states, narrow layouts, reduced motion, focus restoration, both themes |
| `oct25-live-final` | 10 | Live frame probes, narrow dialogs with motion enabled, plain-sheet reversals and restored keyboard/focus in both themes |
| `oct25-machine-motion-final` | 16 | Saved machine-launch/modal regression, now checking content, face and shadow continuity as well as geometry, in both themes |

All four reports say `verified: true`, with zero errors/warnings. Representative
PNGs were inspected. The 108 checkpoints use real product components in the
isolated preview, never `--fixture`. The live opening probes sampled at most
31.2px of travel per frame and frame intervals at most 17.2ms in these runs;
they verify continuity for this transition, not a general frame-rate guarantee.
Disposable detailed scenarios remain in ignored capture artifacts. The saved
machine-motion scenario retains focused regression coverage.

Capture processes exited. The pre-existing preview server was reused and left
running; no validation-owned server remains. These are unpackaged macOS renderer
checks; packaged-app and Windows/Linux runtime launches were not performed.

## Complete title-island review, 2026-10-25

Reviewed the latest ZIP's TitleIsland, IslandName, IslandEvent, MachinePanel,
TitleBar and motion reference against the actual Angular components in Electron.
Standard states match the live reference's geometry, typography, colors, radii,
shadows and motion settings in both themes. The reference was extracted directly
from the current ZIP and uses the same locally bundled fonts.

Corrected the remaining workspace title-bar duplication (44px versus the designed
34px), long-event centering and clipped actions, narrow panel sizing, outside-click
focus stealing, and keyboard focus when all panel actions are disabled. The shell
now reuses TitleBar. Its island keeps the 5px top anchor, fits its containing region,
and grows above the workspace; trusted clicks verify the expanded panel's stacking.
Long event text truncates before Disconnect; the full name remains in the panel.

Passed `pnpm desktop:lint`, `pnpm desktop:test` (152 renderer tests, existing IPC
type checks, 4 preload/security and 7 capture-tool tests), preview TypeScript,
`pnpm desktop:build` and `git diff --check`. The production build runs on the host;
the sandboxed Angular production process aborted with SIGABRT.

Final reports under `artifacts/desktop-capture/`:

| Directory | Captures | Coverage |
| --- | ---: | --- |
| `pill-audit-reference` | 12 | Current ZIP's live reference in both themes |
| `pill-audit-reference-match` | 12 | Standard-state style and geometry assertions against that reference |
| `pill-audit-final-states-confirmed` | 42 | Every tone; local/SSH/peer, guests/empty, hover/highlight/disabled; outside and keyboard focus; progress midpoint; long names at 640/400px |
| `pill-audit-final-motion` | 24 | Spring/blur frames, panel entry/exit, interruptions, reduced motion, and visible/clickable workspace composition in both themes |
| `pill-audit-machine-flow` | 40 | First-run preparation, connecting/installing, launch, open-machine update and failure/empty flows |

All reports say `verified: true`, with zero errors/warnings. Relevant final PNGs
were inspected, including the composed workspace, disabled focus and narrow layouts.
The 118 product checkpoints use the real renderer preview; none uses `--fixture`.
The existing preview server was reused and left running; the temporary reference
server was stopped. No dependencies, tokens, IPC or privileged-process code changed.
These are unpackaged macOS renderer checks; no packaged or cross-platform launch
is claimed. The reusable state and motion scenarios are in the capture guide.

## Preparation title-island correction, 2026-10-25

The preparation island previously measured 48px high inside a 40px bar, extending
16px below it. It incorrectly composed the padded IslandEvent notification inside
the compact summary. Preparation and open-machine updates now use the reference's
13px icon and one line of 12px/600 text, info tone and live progress. The shared
TitleBar matches the reference's 34px height.

Native reference and renderer measurements match in both themes for “Getting This
Mac ready 42%”: 200×24px, 12px horizontal padding, 7px gap, 5px above/below and zero
horizontal center offset. Progress updates and preparation-step changes keep the
text visible rather than replaying the entry animation.

Passed `pnpm desktop:lint`, `pnpm desktop:test` (150 renderer tests plus the existing
runtime/type checks), `pnpm desktop:build` and `git diff --check`. Native reports:

| Directory under `artifacts/desktop-capture/` | Captures | Coverage |
| --- | ---: | --- |
| `preparation-island-reference` | 2 | Supplied live reference, identical text/data, light/dark |
| `preparation-island-fixed` | 40 | Complete machine flow with compact geometry assertions for first run, pending preparation, added server and updates |
| `preparation-island-motion-verified` | 21 | Existing title-island spring, rich events, details, focus, reduced motion, narrow layout and workspace composition |
| `preparation-island-comparison` | 10 | Exact measured geometry and cropped PNGs; progress/phase updates without text replay; resting and update states in both themes |

All reports are `verified: true` with zero errors/warnings. Relevant PNGs were
inspected. Temporary reference/capture processes were stopped; the pre-existing
renderer server was reused and left running. Native Electron/window-control settings,
IPC, tokens and dependencies are unchanged. This remains unpackaged macOS validation.

## Machine onboarding redesign, 2026-10-24 (latest ZIP)

The current archive replaces RunChoice with AddMachine/MachineAdd and moves
initial engine download, connection and installation onto Home's machine cards.
Full-window GettingReady is reserved for an update inside an already open machine.
All 86 imported specification/token/index files match the latest ZIP byte for byte;
3 archive files were added, 3 removed and 21 modified. Tokens and dependencies are
unchanged. The existing frontend/backend/Electron application is untouched.

Validated on macOS with Node 24.22.1, repository-pinned pnpm 8.15.4 and the locked
Angular/CDK/Electron dependencies:

| Check | Result |
| --- | --- |
| `pnpm desktop:lint` | Passed |
| `pnpm desktop:test` | 150 renderer tests in 38 files; 4 preload/security and 7 capture-tool tests passed; IPC negative types checked with `tsc` |
| `pnpm desktop:build` | Passed on the host; 246.62 kB initial renderer bundle |
| Source/dependencies | `git diff --check` passed; no manifest/lockfile or privileged-process changes |

The final native reports under `artifacts/desktop-capture/` each record
`verified: true`, zero errors and zero warnings. Representative PNGs were inspected.

| Directory | Captures | Coverage |
| --- | ---: | --- |
| `machine-design-final` | 40 | First run/later Home, local/server/peer preparation, SSH keyboard/key flow and Back, pairing discovery/error, last selection wins, launch onto NewProject, open-window update isolation, search/empty state, both themes, reduced motion, narrow dialog and focus restoration |
| `machine-motion-final` | 16 | Actual card origin, uniform view scaling, both launch reversal directions, trigger-anchored modal origin, modal reversal/reopen and native focus after reuse, in both themes |
| `machine-update-git-regression` | 60 | Existing full/compact Commit/Push transitions, interruptions and reduced motion in both themes after the shared sizing changes |
| `machine-reference-verified` | 4 | Supplied live React reference: AddMachine light/dark, MachineCard and MachineHome; comparison evidence only |

The 116 product checkpoints use the actual renderer preview in native Electron,
never `--fixture`. The reference server uses the same bundled fonts and serves its
inline example scripts as local files under the unchanged desktop CSP. It is not
shipped. Surface probes isolate the measured animations; the flow captures check
composed states. These are measured behavior/layout/motion checks, not exhaustive
pixel-identity or WCAG certification.

Regressions added for stable machine identity/grouping through preparation,
changed-key invalidation, typed confirmation intents, first attached portal sizing,
unscaled geometry, destination focus during motion and projected-style cleanup.
Native validation exposed and corrected inherited inactive state on animated views,
zero-sized initial portal measurements and interrupted geometry/focus handoffs.

The two reusable machine scenarios are documented in the capture guide. All
validation servers were stopped after verification. This is unpackaged macOS
verification; packaged-app and Windows/Linux launches were not performed. Actual
SSH/pairing, engines, persistence and window opening remain supplied-data/platform
integration boundaries. The older sections below describe previous archive states.

## Updated design system, 2026-10-24

Validated on macOS with Node 24.22.1, cached repository-pinned pnpm 8.15.4 and
the locked Angular/CDK/Electron dependencies. No dependencies, lockfiles, tokens,
legacy application files, Electron/preload/protocol code or IPC contracts changed.
All 86 imported project specification/token/index files match the supplied
extraction byte for byte. The ZIP and local extraction/comparison directories
remain outside the tracked change.

The updated public components and typed intents are documented in
[the project guide](src/app/projects/README.md),
[settings APIs](src/app/projects/project-settings/README.md),
[sheet APIs](src/app/ui/sheet/README.md) and
[task APIs](src/app/tasks/README.md). `pnpm desktop:preview` exposes Projects,
Settings, Sub-tasks and Git helpers alongside the existing examples. Fixtures and
their simulated folder providers stay in the separate preview entry.

| Check | Result |
| --- | --- |
| `pnpm desktop:lint` | Passed, including the isolated previews |
| `pnpm desktop:test` | 140 renderer tests across 37 files, 4 preload/security tests and 7 capture-tool tests passed; IPC negative types checked through `tsc` |
| `pnpm desktop:build` | Passed; initial renderer 246.62 kB, workbench loaded lazily |
| Preview TypeScript | Passed through the installed TypeScript compiler |
| Source review | `git diff --check` passed; source, public barrels, ownership/cleanup and dependency boundaries reviewed |
| Native UI | Actual Angular preview and live reference rendered in Electron; no `--fixture` evidence |

Final product reports under `artifacts/desktop-capture/` all say `verified: true`:

| Directory | Checkpoints | Coverage |
| --- | ---: | --- |
| `run-brMRSJ` | 8 | NewProject repository/name/look, light/dark, modal dismissal and opener focus |
| `run-kbh8cy` | 5 | Project launch at 0/300/600/940ms and landing into New task |
| `run-NgEww3` | 4 | Interrupted launch, reduced motion, ProjectMenu keyboard and archive intent |
| `project-states-verified` | 6 | Busy/disabled Look in both themes, exact popup width/offset, async loading/error/empty |
| `settings-final` | 14 | Wide/narrow light/dark, inline edits, nested Delete/Remove, focus, async folder states |
| `settings-final-motion-continuity` | 7 | Actual surface origin, synchronized shell/modal motion, both reversal boundaries, reduced motion and opener focus |
| `retained-activity-verified` | 6 | Typing during project landing, preserved draft, retained/inert NewProject and repository-add exits, popup cleanup, navigation cleanup and restored opener focus |
| `task-update-verified` | 12 | Sub-task hierarchy/path/overflow/merged states; repository-specific branches; existing-branch From/Create focus; disabled/empty and reduced motion |
| `git-jobs-final` | 4 | Merge/job/waiting states, step popover, helper/cancel intents, Escape focus, JobBrief, both themes |
| `close-task-final` | 4 | Shared recession, light/dark, Escape/opener focus and push/ticket confirmation intent |
| `design-update-git-motion` | 60 | Existing persistent-button, full/compact, interpolation, interruption and reduced-motion regression |
| `design-update-sidebar-motion` | 56 | Add/remove 100 tasks, sparse survivors, stable identities, reversals, stage/filter/session changes, scrolling and reduced motion |

These 186 product checkpoints include PNGs, layout/focus/accessibility snapshots
and motion diagnostics. Representative PNGs in both themes were inspected.
There are no renderer errors. Some development previews report Angular NG0956
for intentional single-label animation layers or draft-remount fixtures; the
Git, sidebar, settings, CloseTask and job-popover final runs have no warnings.
Preliminary failed captures are retained for diagnosis and excluded above.

Live reference reports are `run-ToEHmB` (NewProject), `run-DjhfG8`
(ProjectMenu), `settings-reference-final` (General/narrow settings) and
`task-reference-verified` (TaskGroup/NewTask with identical supplied data).
The temporary reference server used the supplied bundle, externalized its inline
scripts for the existing CSP and served the same bundled fonts. Reference source
bytes were preserved. Matched measurement results, subpixel label-width rounding
and the reference's stale pre-font width cache are recorded in
[DESIGN_REVIEW.md](DESIGN_REVIEW.md); raw PNG identity is not asserted.

Native captures and the motion probes verify the unpackaged macOS app. Packaging
and Windows/Linux runtime validation were outside this component update. The
native smoke was not rerun because Electron/preload/protocol code was unchanged.
The sandboxed Angular builder aborted; the required production build passed on
the host with the same installed tools and security configuration.

Checked on macOS, 2026-10-22, using the workspace's locked dependencies and the
already installed Node 26 runtime. No dependency versions or lockfile changed.

| Check | Result |
| --- | --- |
| `pnpm desktop:lint` | Passed, including production source and isolated previews |
| `pnpm desktop:test` | 64 renderer tests across 16 files, 4 preload/security tests, 7 capture-tool tests passed; negative IPC types checked through `tsc` |
| `pnpm desktop:build` | Passed; initial renderer bundle 236 kB, workbench loaded lazily |
| Native Electron smoke | Passed sandbox, bridge validation, subscription cleanup, theme updates, multiple windows, history fallback, CSP and missing assets |
| Production renderer capture | `app://` launch, nonce replacement, local fonts, shell layout, empty state, light/dark passed |
| Interactive component capture | Typed example data, task wizard keyboard flow, inferred branch selection, CDK menu Escape/focus restoration, agent picker, review takeover, hidden-panel inertness, Browser and Terminal frames passed |
| Motion frames | Panel widths sampled at 0/140/280 ms; rail stayed fixed. Machine launch sampled at 0/280/560 ms. Wider review sampled in both directions, preserving chat width throughout |
| Preview command/HMR | `pnpm desktop:preview` started successfully; a temporary template update appeared in the live renderer and its original bytes were restored |
| Source review | `git diff --check` passed; existing legacy app commands and dependencies retained |

Native captures use the actual components in Electron, never `--fixture`.
Reports under the ignored `artifacts/desktop-capture/` directory:

- `component-system-initial`: ten light/dark family gallery captures.
- `component-system-final`: eight corrected workspace/interaction captures.
- `component-system-motion`: six panel and machine animation frames.
- `component-system-takeover`: six review animation frames plus light workspace.
- `component-system-production`: two production `app://` theme captures.
- `component-system-hmr`: applied/restored live-template captures.

Each listed report records `verified: true` and no renderer errors. Relevant
PNGs were visually inspected. A preliminary interaction run hit a stale Chromium
animation-tracker ID after changing reduced motion; the successful motion runs
use live DOM animation handles to scrub the owned animations precisely.

This verifies the unpackaged native app on macOS. Installer packaging and
Windows/Linux runtime verification were not part of this component-only change.
Repository/agent data integration remains a separate application layer.

## Follow-up design audit, 2026-10-22

The audit and outstanding parity work are recorded in [DESIGN_REVIEW.md](DESIGN_REVIEW.md).

- `pnpm desktop:lint` passed.
- `pnpm desktop:test` passed: 87 renderer tests across 23 files, 4
  preload/security tests, and 7 capture-tool tests. IPC types were checked with
  `tsc`.
- `pnpm desktop:build` passed (238 kB initial renderer bundle).
- `git diff --check` passed. No dependencies or lockfile changed.

Native reports under `artifacts/desktop-capture/`:

| Directory | Coverage |
| --- | --- |
| `design-audit-themes` | Ten light/dark workspace and component-family captures, including reduced-motion navigation and visible loading skeletons |
| `design-audit-interaction-motion` | Keyboard Deny, tools-to-mention insertion/focus, island dialog Escape/focus, terminal Find/restore in both themes; panel 0/140/280 ms and launch 0/280/560 ms frames |
| `design-audit-retained-exits` | Four light/dark captures asserting that departing toasts/tabs are inert and hidden from assistive technology; keyboard navigation skips retained closing tabs |
| `design-audit-machine-focus` | Launch frames, hidden-view inertness and return focus after removing redundant `aria-hidden` bindings |
| `design-audit-production` | Two production `app://` empty-workbench captures, native theme updates in light and dark |

Each final report records `verified: true`; representative PNGs were inspected.
The interaction/motion run exposed Chromium warnings from redundant
`aria-hidden` on focused outgoing machine views. The final machine-focus run
verifies the correction using `inert` alone. Preliminary failed runs are retained
as diagnostics, not counted as successful verification.

Capture setup uses full native Enter events for browser button activation,
waits for route/entry animations before freezing, and seeks live DOM animation
handles after media changes to avoid stale Chromium protocol animation IDs.
The host's global pnpm version manager stalled; commands used the already cached
repository-pinned pnpm 8.15.4 through a temporary PATH shim. A sandboxed Angular
build aborted; its normal host retry passed. No toolchain upgrade was performed.

This remains unpackaged macOS verification. The production route is the empty
workbench; supplied-data preview captures exercise the reusable feature families.

## Git and sidebar motion, 2026-10-22

Commit/Push now keeps its primary and menu buttons mounted throughout the cycle.
Measured action/stat slots retain their outgoing content, labels leave before
the next label arrives, counts roll, and interrupted widths resume from their
painted value. The title, branch, links and right edge retain their positions.

The sidebar retains removed task/session identities while their complete space
folds closed. Stage headings, row spacing, empty state and Closed count use the
same folding layout. Returning an identity during removal revives its existing
component. Nested FLIP scopes own separate rows; reorders start from the current
painted position. Reduced motion now removes transition durations and delays
entirely, including the previous 40ms Fold ink delay.

| Check | Result |
| --- | --- |
| `pnpm desktop:lint` | Passed |
| `pnpm desktop:test` | 99 renderer tests across 25 files, 4 preload/security tests and 7 capture-tool tests passed; IPC types checked with `tsc` |
| `pnpm desktop:build` | Passed; 239.6 kB initial renderer bundle |
| `git diff --check` | Passed; no dependency or lockfile changes |
| `sidebar-expanded-verified/report.json` | `verified: true`, 56 captures / 54 frame probes, no errors or warnings |
| `git-motion-final/report.json` | `verified: true`, 60 captures / 56 frame probes, no errors or warnings |
| `motion-preview-final/report.json` | Both themes; interactive target/session selectors agree with the fourth-task model selection |

The reports above are under `artifacts/desktop-capture/`. Sidebar coverage
includes additions/removals at the start, middle and end, adding 100 tasks,
collapsing 110 tasks to two, retaining only original task 4 or tasks 4 and 7,
empty/restore, reversal, interruption during reversal and removal, filtering,
stage/session changes, middle/bottom scrolling, and reduced motion in both
themes. Surviving task DOM identity remains stable; measured first-paint and
settled boundary displacements were 0px in the non-reduced sidebar cases.

Git coverage includes all nine demo states, full/compact controls, 80ms
interruptions and reduced motion in both themes. Widths matched the live
animation curves within 0.009px; keyframe endpoint mismatch, settled snap and
title/branch/link/right-edge drift measured 0px. Outgoing/incoming labels did not
overlap visibly. Long rAF sampling gaps are recorded separately from curve
errors; the probe checks actual animation progress rather than assuming an
uninterrupted frame interval.

Representative light/dark PNGs were inspected. The separate **Sidebar motion**
and **Git motion** preview pages expose the same operations for manual review.
The reusable scenarios and invocation commands are documented in
`scripts/desktop-capture/README.md`. These remain native unpackaged macOS checks,
not packaged-app or cross-platform performance claims.
