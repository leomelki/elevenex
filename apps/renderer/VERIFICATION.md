# Component system verification

## Hide empty archives, 2026-10-27

Passed `desktop:lint`, `desktop:test` (347 Angular tests plus the existing main,
contract and capture-tool checks), `desktop:build` and `git diff --check`.
Native report [`run-hppnyZ`](../../artifacts/desktop-capture/run-hppnyZ/index.html)
contains 12 checkpoints and reports `verified: true`, with no renderer errors.
New light/dark and narrow reduced-motion PNGs were inspected. The scenario checks
hidden empty archives, first archive, refresh, restore of the last archived row,
focus and independent pagination. One previously recorded NG0956 warning remains.
Unit tests cover the one-row existence probe and an empty older window that must
check the latest page before hiding history. No backend or bridge changes.
The owned preview server was stopped. Captures use isolated preview data rather
than a packaged app or a live provider.


## Browsable archived sessions, 2026-10-27

Passed `desktop:lint`, `desktop:test` (99 main/preload/security, 7 capture-tool,
345 Angular tests and TypeScript checks), `desktop:build`, 15 focused backend
workspace tests, backend TypeScript, native Electron smoke and `git diff --check`.
No dependencies, lockfiles or database schema changes. Tests/build/preview needed
local listener and worker permissions outside the sandbox; validation used the
installed repository-pinned pnpm 8.15.4.

Native reports [`run-u6XmfM`](../../artifacts/desktop-capture/run-u6XmfM/index.html)
(10 archive browsing checkpoints) and
[`run-eIME5m`](../../artifacts/desktop-capture/run-eIME5m/index.html)
(26 existing sidebar archive/cap checkpoints) report `verified: true`, with no
renderer errors. Light/dark and narrow reduced-motion PNGs were inspected. The
new scenario covers explicit archive, dismissing Undo, selecting archived history,
refresh persistence, independent restore and focus after entry, empty disclosure,
keyboard toggling and bounded Earlier pagination without replacing normal rows.
Existing running confirmation, Escape/blur, Undo, attention shortcuts, settings,
filters and interrupted transitions pass. Reports retain the previously recorded
NG0956 development warnings.

Unit tests cover lazy capability gating, task/lifecycle validation, bounded pages,
normal completed sessions, restored selection, stale task/scope replies, cleanup,
failed-read retry, duplicate reads and reconciliation after pre-mutation reads.
Backend omission semantics for older callers and closed-task history remain
covered. Native smoke verifies the real sandboxed preload/protocol with fixture
backend data. Captures use production components with isolated preview data;
these checks do not establish a packaged-app or live-provider launch. The owned
preview server was stopped after validation.


## Completed sessions remain normal, 2026-10-27

Passed `desktop:lint`, `desktop:test` (99 main/preload/security, 7 capture-tool,
338 Angular tests and TypeScript checks), `desktop:build` and `git diff --check`.
Sandbox loopback/worker restrictions required rerunning tests, preview and build
outside the sandbox, using the installed repository-pinned pnpm 8.15.4.
No backend, IPC, dependency or lockfile changes.

Native reports [`run-3Sb7Fl`](../../artifacts/desktop-capture/run-3Sb7Fl/index.html)
(26 archive/cap checkpoints) and
[`run-1JGI9w`](../../artifacts/desktop-capture/run-1JGI9w/index.html)
(6 completion checkpoints) report `verified: true`, with no renderer errors.
Light/dark and narrow reduced-motion PNGs were inspected. The archive regression
covers running confirmation, keyboard/focus, Undo restoring normal rows, filters,
settings and interrupted disclosures. The disposable completion scenario verifies
that unselected task and sub-task sessions remain visible in order after finishing,
with native Tab navigation. Unit tests verify row identity through completion,
merged-branch disclosure, selection of completed/stopped neighbours after archive,
wraparound and removal of the last session. The archive report retains previously
recorded development NG0956 warnings; the completion report has no warnings.
These captures use real components with isolated preview data and do not verify
a packaged app or live provider. The owned preview server was stopped afterward.


## Project-switch task retention, 2026-10-27

Passed `desktop:lint`, `desktop:test` (99 main/preload/security, 7 capture-tool,
335 Angular tests and TypeScript checks), `desktop:build` and `git diff --check`.
Sandbox loopback/worker restrictions required rerunning tests, preview and build
outside the sandbox, using the installed repository-pinned pnpm 8.15.4.
No backend, IPC, dependency or lockfile changes.

Native reports [`run-2jY9nW`](../../artifacts/desktop-capture/run-2jY9nW/index.html)
(12 task-retention checkpoints) and
[`run-7l2Pmr`](../../artifacts/desktop-capture/run-7l2Pmr/index.html)
(14 existing disclosure checkpoints) both report `verified: true`, without
renderer errors. New light/dark and narrow reduced-motion PNGs were inspected.
The new regression samples every frame and observes DOM mutations during 450ms
task reads, beyond the old presence cleanup deadline. Both project directions
preserve matching task/session DOM identity and outer folds, retain manual
collapse, and remove only other projects, with no selection or another project
selected. Unit tests also delay session reads, retain matching selections,
and cover failed reads and stale navigation. Existing reveal/create/archive,
refresh, filter and Show fewer behavior passes. Reports retain the previously
recorded development NG0956 warnings. These captures exercise production
components with preview-only backend data; they do not verify a packaged app
or live backend. The owned preview server was stopped after validation.

## Session disclosure persistence regression, 2026-10-27

Passed `desktop:lint`, `desktop:test` (99 main/preload/security, 7 capture-tool,
332 Angular tests and TypeScript checks), `desktop:build` and `git diff --check`.
No backend, IPC, dependencies or lockfiles changed. New tests cover refreshed
DTOs, added/removed sessions, fully expanded arrivals, task identity, list
replacement/remount, cache eviction, project navigation and backend-scope reset.

Native reports [`run-OJZ8rg`](../../artifacts/desktop-capture/run-OJZ8rg/index.html)
(14 disclosure checkpoints) and
[`run-PvYY78`](../../artifacts/desktop-capture/run-PvYY78/index.html)
(24 existing archive/cap checkpoints) report `verified: true`, with no renderer
errors. New light/dark PNGs were inspected. The focused scenario covers project
navigation in both directions with and without a retained selection, partial and
full reveals, archive/create, refresh, filters and explicit Show fewer; dark mode
uses reduced motion. The existing scenario retains normal motion, interruptions,
keyboard/focus, Undo, settings and narrow checks. Development NG0956 warnings are
retained in report.json. These preview captures use the real production owner
with isolated backend data; they are not a packaged-app or live-provider test.
The owned preview server was stopped after validation.


## Session archive and working cap, 2026-10-27

Passed `desktop:lint`, `desktop:test` (99 main/preload/security, 7 capture-tool
and 329 Angular tests, plus IPC/renderer TypeScript checks), `desktop:build`,
14 focused backend workspace tests, backend TypeScript, native Electron smoke
and `git diff --check`. No dependencies, lockfiles or schema migrations changed.
Sandbox-only native worker/loopback restrictions were rerun outside the sandbox,
using the already installed repository-pinned pnpm 8.15.4. The owned preview
server was stopped after validation.

Native preview reports
[`run-tL4sJx`](../../artifacts/desktop-capture/run-tL4sJx/index.html) (24 session
states), [`run-hONZaH`](../../artifacts/desktop-capture/run-hONZaH/index.html)
(32 existing sidebar states) and
[`run-LRZ20w`](../../artifacts/desktop-capture/run-LRZ20w/index.html) (64 existing
sidebar motion checkpoints) all report `verified: true`, with no renderer errors.
New light/dark PNGs were inspected. Coverage includes the latest-five cap,
attention/failed exceptions, ghost/count and repeated batches, Show fewer/focus,
filters, hover, in-place running confirmation, Escape/blur/Enter, next-session
handoff/focus, nonrunning and attention-shortcut archive, Undo, persistent setting,
narrow layouts, reduced motion and interrupted reveals. Pure tests cover fresh
and selected exceptions, disabled/absent actions, confirmation listener cleanup,
failed writes/restores, stale scopes, preference persistence/failure, and pending
asynchronous Toast actions. Existing sidebar state/motion scenarios also retain
empty/busy, menus, long labels, list identity and cleanup checks.

Live reveal probes measured about 18.3px maximum per frame for five rows opening
and 50.6px for fourteen closing together on the supplied curve, with frame gaps
under 19ms in the session run. These are diagnostic geometry samples, not a
frame-rate benchmark. Dev reports retain Angular NG0956 tracking warnings; their
full text is preserved in report.json. Scrubbed capture attempts were replaced
by live probes because Ticker cleanup timers can remove paused animations.

The smoke uses the real sandboxed preload and app:// protocol with a backend
fixture. It does not certify live provider cancellation, a packaged-app launch,
or Windows/Linux behavior. Session caps/exceptions apply within the connected
owner's bounded session window, with explicit older-page navigation. The current
new renderer still has no connected conversation search/@mention UI; archiving
preserves existing durable conversations for those integrations.


## Connected sidebar edge cases, 2026-10-26

Passed `desktop:lint`, `desktop:test` (97 main, 7 capture-tool and 293 Angular
tests, plus IPC/renderer TypeScript checks), `desktop:build`, ten focused backend
workspace tests, native Electron smoke and `git diff --check`. No dependency or
lockfile changes. Sandbox-only loopback/Angular worker failures were rerun
successfully outside the sandbox.

Native preview reports
[`run-cnJ8eC`](../../artifacts/desktop-capture/run-cnJ8eC/index.html) (24 states)
and [`run-syOsCc`](../../artifacts/desktop-capture/run-syOsCc/index.html) (64 motion
checkpoints) both report `verified: true`, with no renderer errors. Inspected new
PNGs in both themes. Coverage includes single/multiple repositories and All
projects, attention/failure/selection hover, full-title tooltip bounds, keyboard
focus/menu restoration, empty/filtered/closed states, disabled actions, scrollable
20-task windows, narrow layouts, reduced motion and interrupted list changes.
Tooltip tests also cover focus-to-hover handoff, Escape and destruction cleanup.
Context-replacement captures retain Angular NG0956 identity warnings; motion
captures have none. These use controlled preview backend data, and the smoke uses
its isolated backend fixture; neither establishes packaged-app validation.

Repository-count metadata is additive and runtime validated. Older runtimes
without the field preserve their prior repository hints. Backend regressions
verify cardinality even when the bounded task page contains only one repository.
Store regressions verify that failed replacement reads cannot show the previous
project's task rows under the new heading.

## Existing-branch Enter submission, 2026-10-26

Existing branches now skip the unused From/base lookup. The previous lookup
briefly disabled Create task during the scheduled focus handoff, leaving plain
Enter with no focused action once loading ended. The regression test reproduced
the unnecessary request before the fix and now verifies that Create remains
enabled and focused. New-branch base selection and current-branch validation
retain their existing behavior.

Passed desktop lint, production build, the complete desktop test command (96
main tests, 7 capture-tool tests, 282 Angular tests and IPC type checks), and
diff checks. Native preview report `run-c17IM6/report.json` is verified with zero
errors: four inspected light/dark checkpoints cover the history-preserving From
message, enabled/focused Create action and actual task creation through trusted
Enter. The native scenario uses production components and controlled backend
data; it does not certify a packaged app or perform real Git checkout operations.

## Smooth folder typing, 2026-10-26

Compared the legacy path autocomplete's debouncing, cancellation and explicit
caret handling, then kept the new renderer independent of its implementation.
`FolderSuggestionsSource` now owns eight bounded windows of at most 50 entries,
current-request cancellation, delayed feedback and cleanup. Compatible directory
windows filter immediately while fresh reads run. Incompatible paths and Git
URLs never reuse another query's rows. A provider identity captured by backend
scope clears the cache on connection replacement.

The popup and keyed rows remain mounted through typing; highlights retain folder
identity. Shared AutoHeight and FittedHighlight ease size/selection changes,
loading feedback waits 150ms, and new-directory waits use bounded skeletons.
Normal replies preserve the caret and text selection. Explicit Tab completion
keeps home notation, adds `/` and puts the caret at the end. Delayed Enter/Tab is
applied once to its own query and cancelled on editing, blur or navigation.
Composition pauses requests and keyboard intents, and clicking the field reopens
suggestions. Only the suggestion viewport scrolls during keyboard navigation.

Passed `pnpm desktop:lint`, `pnpm desktop:build`, `pnpm desktop:test` (98 main,
7 capture-tool, 295 Angular tests and IPC type checks), plus `git diff --check`.
No dependencies, lockfiles, design tokens or legacy app files changed.
Native preview reports `run-EjhT0A/report.json` (14 typing checkpoints) and
`run-fJT8lM/report.json` (24 project checkpoints) both say `verified: true` with
zero errors. Coverage includes controlled latency, retained DOM identity,
immediate filtering/backtracking, caret and highlight preservation, home-path
completion, direct Enter, retry, both themes and narrow reduced-motion layout.
The filtering, loading, completion and narrow PNGs were inspected. These use the
real renderer components with an isolated backend fixture; they are not packaged
app or external-server checks.

## Tab browses directories, 2026-10-26

Tab now completes a directory with a trailing `/` and requests its children,
including when the directory name is already complete. Enter selects the
highlighted directory directly. Removed the previous completed-entry cache so
Enter after browsing cannot select the old parent. Pending-query completion and
Git URL behavior are preserved. The home default remains `~/`.

Passed lint, diff checks and 19 focused project/picker tests. Native report
`run-0xkN9X/report.json` verifies 24 checkpoints with zero errors, including
pending Tab, exact-name Tab, child suggestions and direct Enter selection in
both themes. Light/dark completion PNGs were inspected.

## Home folder default, 2026-10-26

New project and the settings Add repository picker start at `~/`. Removing the
last selected repository resets New project to `~/`; explicit draft queries and
clone destinations retain their existing behavior. Focused project/picker tests
passed (18 tests), lint and diff checks passed. Native report
`run-O5SFVt/report.json` verifies six light/dark initial/reset/settings states
with zero errors; initial picker and settings PNGs were inspected.

## Folder completion and project landing, 2026-10-26

The folder picker now completes paths without an implicit descent. An exact
folder without `/` returns that folder alone; a trailing `/` lists its immediate
children. Tab completes the highlighted path without appending a slash, including
when pressed before the debounced request resolves. A completed selection stays
available to an immediately following Enter. Enter selects plain folders as well
as existing repositories. Stale results cannot complete a newer query; Git URLs
retain their remote value on Tab.

Project creation now reveals the selected project's workspace and focuses its
prominent New task action after the modal exit or first-project flight. No task
dialog or branch lookup starts automatically. Explicitly pressing New task still
opens the existing form. Navigation/scope changes discard pending focus requests.
The visible action was chosen over an inline form to keep project navigation
available and leave task setup as an explicit next step, at the cost of one click.

Passed lint, production build, backend production TypeScript, 17 focused backend
tests and all 288 Angular tests. Main/security and capture-tool suites passed
98 and 7 tests. A leaked media-query test stub exposed a CDK legacy-listener
error on the first aggregate run; the touched project suites now provide both
listener APIs and restore their global stubs, and the full Angular rerun passes.

Native reports `run-FxGkSR/report.json` (24 project checkpoints) and
`run-e71Kim/report.json` (22 workspace checkpoints) both report `verified: true`
with zero errors. Trusted Tab/Enter, exact-directory selection, explicit child
browsing, retry, modal closure, first/later project creation, explicit New task
activation, both themes, narrow layout and reduced motion are covered. Completion,
child-list, full-window/narrow landing and first-project PNGs were inspected.
These use the production components with the isolated preview backend.

## New project completion, 2026-10-26

The production New project flow now supports explicit plain-folder Git setup,
HTTPS/SSH clone intents, bounded current-branch metadata, picker empty/error/retry
states, nested Escape, native Enter on appearance controls, inline retained
creation failures and explicit uncertain-outcome reconciliation. Repository setup
has its own backend module and cancellation deadline; existing path-only callers
retain their defaults. No dependencies, lockfiles or tokens changed.

Passed desktop lint, the complete desktop test command (98 main tests, 7 capture
tool tests, 284 Angular tests and IPC type checks), production build and native
Electron smoke. Focused backend tests passed 27 tests in three suites, including
real Git initialization and real project HTTP/SQLite integration. Backend
production TypeScript passes. The broader backend all-spec TypeScript invocation
still reports existing errors in unrelated test suites; it is not the production
build configuration.

Native preview reports `run-Ma77wt/report.json` (22 connected-workspace checkpoints)
and `run-1jUn36/report.json` (20 project checkpoints) both say `verified: true`
with zero errors. Both themes, modal/opener focus, keyboard retry, multiple
repositories, name and appearance, rejected and uncertain creates, 390px reduced
motion and the New task handoff are covered. The project, picker, failure,
recovery and narrow PNGs were inspected. Existing small draft/choice tracking
warnings remain recorded in the reports.

These are unpackaged macOS checks with an isolated preview backend. Clone URL
validation, process arguments, failure cleanup and cancellation are tested with
controlled process responses; no authenticated external clone or packaged-app
launch is claimed.

## Connected workspace, 2026-10-26

The production AppShell composes project/task navigation, project setup/settings,
task preparation/retry, stages, git operations and side-view shells. Selected
sessions retain the task header with an empty main region. The reusable
conversation components and their preview remain at the earlier foundation state.

After removing the connected chat implementation, `pnpm desktop:lint`,
`pnpm desktop:build` and `pnpm desktop:test` passed (96 desktop tests,
7 capture-tool tests, 281 Angular tests, plus IPC TypeScript checks). Backend
build/type checking and 82 focused workspace/session compatibility tests passed.
The native macOS Electron smoke passed with the rebuilt sandboxed preload and
`app://` renderer; this is an unpackaged check.

`artifacts/desktop-capture/run-orBhvd/report.json` reports `verified: true` for
20 checkpoints, with no errors and eight existing small-control tracking
warnings. Inspected PNGs cover the empty selected-session region in both themes,
narrow reduced-motion layouts, side-panel shells, settings, error recovery and
project creation. The regression also checks task creation and keyboard/focus
restoration through the real production composition with a preview-only backend.

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


## Existing-branch task setup recovery, 2026-10-26

The desktop now preserves bounded setup failure details and offers explicit
recovery on the saved task. External checkouts require consent to include local
edits; committed-revision recovery uses a separate workspace. Task ownership and
busy-workspace protections remain in the existing allocator. Unknown mutation
outcomes require durable reconciliation before retrying.

| Check | Result |
| --- | --- |
| `pnpm desktop:lint` and `pnpm desktop:build` | Passed |
| `pnpm desktop:test` | 97 main/preload tests, 7 capture-tool tests, 289 renderer tests; IPC contract type checks passed |
| Backend production TypeScript and changed production files' ESLint | Passed |
| Focused backend adapter, HTTP and setup-error suites | 20 tests passed |
| Focused task lifecycle tests with disposable real Git repositories | 4 passed, including external-checkout consent, local-edit preservation and isolated snapshot recovery |
| Native Electron smoke | Passed on macOS with sandbox, production bridge and CSP |
| `git diff --check` | Passed; no dependency or lockfile changes |

The final native preview report is
`artifacts/desktop-capture/run-TwTC7B/report.json`: `verified: true`, 10 checkpoints,
no errors. It covers both recovery choices in light/dark themes, narrow layouts,
reduced motion, keyboard task submission and continuation of the same task ID.
Representative light, dark/narrow and ready-state PNGs were inspected. The report
records Angular identity-tracking warnings in existing composed controls.
The reusable scenario is `scripts/desktop-capture/scenarios/task-setup-recovery.mjs`.

These are unpackaged macOS and controlled-preview checks. The user's existing
failed task and external checkout were inspected read-only and were not retried
or modified; loading the updated backend and making a recovery choice remains
a user action. This does not establish packaged-app or cross-platform behavior.

## Task-screen design update — 2026-10-27

Imported the October 27 brand/component specifications and types. Both token
files match the supplied ZIP byte for byte. The Angular implementation adds the
anchored commit panel, persistent quiet Close task, selected-task New session row
and ⌥⌘N. The connected owner includes paged commit previews, explicit exclusions,
snapshot commits and close/Undo. No dependencies or legacy app commands changed.

Validation:

- `pnpm desktop:lint` and `git diff --check` pass.
- `pnpm desktop:test` passes: 98 main/preload tests, 7 capture-tool tests and 308
  renderer tests, including TypeScript contract checks. The final panel motion,
  initial-data and focus-trap adjustments were rechecked with its 7 focused
  Angular tests and native captures.
- `pnpm desktop:build` passes with the final renderer.
- Backend Git regressions pass: 94 tests across the affected Git suites, followed
  by 12 focused desktop commit/lifecycle tests after the final snapshot policy
  and module split. They exercise staged-only content, excluded staging, secret
  defaults, concurrent index changes, later session edits and bounded file search.

The final native report is
`artifacts/desktop-capture/run-pD283o/report.json`: **verified: true**, 20
checkpoints, no errors or warnings. New PNGs were inspected in light and dark,
including the actual surface morph (rather than CDK's focus anchors), closed and
expanded file lists, filtering, staged-only, secret inclusion, interrupted close
with a retained draft, narrow reduced-motion layout, one file left after commit
and the New session shortcut. The reusable regression is
`scripts/desktop-capture/scenarios/task-screen-update.mjs`; open the preview at
`--url http://127.0.0.1:4310/connected-workspace` to avoid cancelling its initial
navigation. Initial file data is resolved before measuring the opening morph;
the Commit button remains available for cancellation and announces its busy state.

These are unpackaged native macOS checks with controlled preview backend data.
Real repository preservation is tested separately with temporary Git repositories.
They do not establish packaged-app launch, other OS behavior or live provider
message-generation quality.

## Project selection continuity (October 27)

Project navigation retains a selected task/session when it belongs to the
destination project or All projects. Regression tests cover pending reads,
older session windows, failed reads, another project and superseded navigation.
`pnpm desktop:lint`, `pnpm desktop:test` (98 main/preload, 7 capture-tool and
311 renderer tests), `pnpm desktop:build` and `git diff --check` pass.

The unpackaged native macOS preview report at
`artifacts/desktop-capture/project-session-retention/report.json` is
`verified: true`: four inspected PNGs, light 1440px and dark 960px with reduced
motion. Trusted rail clicks preserve the actual task-header DOM element and
selected session, preserve rail focus, and clear selection for another project.
The report has no errors and four Angular NG0956 collection-identity warnings.
The backend is the isolated preview adapter; this is not a packaged-app check.

The final installed-Electron smoke also passes with `ELECTRON_RUN_AS_NODE`
unset: real sandboxed preload, named bridge validation/cleanup, scoped HTTP,
native theme, multiple windows and `app://` history/CSP. It uses a disposable
backend fixture and is not a packaged-app launch.

### Persistent task add buttons (October 27)

Removed hover/selection visibility rules from task and sub-task header + buttons.
`pnpm desktop:lint`, `pnpm desktop:test` and `pnpm desktop:build` pass, including
311 Angular tests. Tests require loopback listeners and passed outside the
filesystem sandbox; the production build also passed outside it after a
sandboxed attempt aborted with SIGABRT.

`artifacts/desktop-capture/task-plus-always-visible/report.json` reports
**verified: true**, eight checkpoints, no errors or warnings. All eight PNGs
were inspected: every task's + at rest, collapsed-task keyboard focus, narrow
reduced-motion layouts and three nested sub-task headers in both themes.
These are native macOS captures of actual renderer components with isolated
preview data; no packaged-app launch was performed for this CSS-only change.

### Workspace quota recovery (October 27)

Saved quota failures now show a bounded count/limit explanation and an explicit
Create workspace anyway action. The optional recovery flag preserves the prior
issue-code vocabulary for older desktop clients. Backend recovery checks the
durable failed task before granting the existing per-task quota override.

`pnpm desktop:lint`, `pnpm desktop:test` (98 main/preload, 7 capture-tool and
313 renderer tests), `pnpm desktop:build` and the installed-Electron smoke pass.
Focused backend mapping/service/HTTP checks pass (28 tests); the existing task
lifecycle suite also passes, including real-Git quota confirmation recovery.
Loopback tests and native checks ran outside the filesystem sandbox; an unrelated
SSH fixture assertion passed on rerun. No packaged-app launch was performed.

`artifacts/desktop-capture/task-workspace-limit/report.json` reports
**verified: true**, six inspected PNGs, no errors and three existing Angular
NG0956 collection-identity warnings. The native preview covers light/dark quota
explanations, visible keyboard focus, 390px reduced-motion layouts and Enter
recovery preserving the saved task identity. Backend data is the isolated
preview adapter; the capture does not create a workspace in the user's repository.

### Session cap scroll update (October 27)

The latest ZIP's Older/Show fewer row replaces the ghost pill and individual
unrolls. Session placement/disclosure and batch animation have separate internal
owners. Revealed selection/status updates retain their row, archiving backfills
chronologically across batches, and Show fewer keeps the open session visible.

`pnpm desktop:lint`, `pnpm desktop:test` (99 main/preload, 7 capture-tool and
350 renderer tests), `pnpm desktop:build` and `git diff --check` pass. The focused
15-test session suite also passes after the final accessibility assertions and
interrupted-scroll correction. Local listener/process tests and the production
build ran outside the filesystem sandbox after EPERM/SIGABRT sandbox failures.
Dependencies, tokens, bridge contracts and the session archive backend are unchanged.

`artifacts/desktop-capture/session-cap-delivery/report.json` reports
**verified: true**, 14 checkpoints, no errors and 13 existing Angular NG0956
collection-identity warnings. The production connected preview covers both
themes, keyboard focus rings, muted title color without opacity, clipping/mask
cleanup, revealed selection DOM identity, Show fewer selection retention,
mid-close reopening and narrow layouts with reduced motion enabled mid-scroll.
Relevant new light/dark opening, selected and narrow PNGs were inspected.
Sampling begins before trusted input and continues beyond animation cleanup;
only pairs of rAF samples contribute to normalized speeds (the initial baseline
can fall between paints). Five-row opening peaked at 13.3px per 60Hz frame and
ten-row closing at 19.5px, with sampled frame intervals below 19ms. These are
bounded continuity measurements on this Mac, not a general FPS benchmark.

`artifacts/desktop-capture/session-cap-retention/report.json` also reports
**verified: true**, 14 checkpoints, no errors, with 23 existing Angular identity
warnings. It verifies archive/create/refresh, full disclosure, filters, explicit
Show fewer and project-view remount persistence. The earlier broad archive,
Undo, settings and interruption run is verified at
`artifacts/desktop-capture/session-cap-scroll/report.json` (26 checkpoints).
The focused reusable scenario is `sidebar-session-cap.mjs`; use
`--url http://127.0.0.1:4310/connected-workspace` to avoid an initial navigation
race. Animation reversals use live sampling because scrubbing can race the
capture tool's tracked ticker animation IDs.

These are unpackaged native macOS checks with the isolated preview backend.
No packaged-app launch or other operating-system runtime verification is claimed.

### Session cap label transitions (October 27)

The Older/Show fewer label now uses the shared EaseSwap blur/slide and width
animation in both directions. EaseSwap optionally accepts a typed content
snapshot and template; same-phase content updates retain the Ticker, while
phase changes retain outgoing text/count until its exit completes. Plain string
callers retain their prior text and sizing behavior. The native button, immediate
accessible label and reduced-motion behavior remain intact.

`pnpm desktop:lint`, `pnpm desktop:test` (352 renderer tests plus the existing
main/preload and capture suites), `pnpm desktop:build` and `git diff --check`
pass. Focused EaseSwap/session regressions pass (19 tests). The new regression
is `scripts/desktop-capture/scenarios/sidebar-session-cap-label.mjs`.
`artifacts/desktop-capture/session-cap-label/report.json` is **verified: true**:
14 native macOS preview checkpoints, no errors, three existing Angular identity
warnings. Both directions were captured at outgoing, incoming and settled ages
in light/dark; inspected midpoint PNGs show the blur/slide and width interpolation.
It also verifies outgoing count snapshots, stable button and Ticker identities,
cleanup, and narrow reduced-motion behavior. The existing warm preview was reused;
no packaged-app launch was performed.

### Session creation without selection shifts (October 27)

Populated tasks no longer append a creation row when selected. Every available
task header + retains its hover/focus tooltip and native keyboard operation.
Empty tasks offer a labeled New session action independent of selection, with
the existing creation permission, filtering and session-pagination guards.

`pnpm desktop:lint`, `pnpm desktop:test` (354 renderer tests plus the existing
main/preload and capture suites), `pnpm desktop:build` and `git diff --check`
pass. The focused task-list/commit-panel tests pass (24 tests).
`scripts/desktop-capture/scenarios/sidebar-session-creation.mjs` verifies identical
task positions/heights before and after cross-task selection, hover/focus labels,
native Enter creation, empty-task creation, unavailable actions and narrow
reduced-motion layouts in both themes. Its native macOS preview report is
`artifacts/desktop-capture/run-W4mgY3/report.json`: **verified: true**, 10
checkpoints, no errors, nine existing Angular tracking-identity warnings.
The updated `task-screen-update.mjs` regression also passes at
`artifacts/desktop-capture/run-j5Vp9B/report.json`: **verified: true**, 20
checkpoints, no errors or warnings, including the existing new-session shortcut.
Light/dark keyboard-tooltip and narrow empty-task PNGs were inspected. The owned
preview server was stopped. These checks use the unpackaged app and isolated
preview backend; no packaged launch or other operating system was tested.

### Project name availability (2026-10-27)

Creation checks the trimmed name against all backend project records before
enabling Name → Look or any create shortcut. Active, archived and hidden names
are covered by an indexed lookup; duplicate creation is rejected before repository
initialization. Failed checks retain the editable draft; changing the name
automatically checks availability again.

`pnpm desktop:lint`, `pnpm desktop:test` (101 desktop, 7 capture-tool and 358
renderer tests, including TypeScript contract checks), `pnpm desktop:build`, the
22 focused backend HTTP/service tests and the native Electron smoke passed.
Native macOS preview captures in
`artifacts/desktop-capture/run-XXybsU/report.json` are **verified: true**: 12
checkpoints cover existing/archived names, pending/failed checks, available-name
progression, keyboard gating/focus restoration and narrow reduced-motion states
in both themes. Light/dark duplicate-name and narrow PNGs were inspected. The
report has no errors and two existing Angular tracking-identity warnings.
These are unpackaged preview checks with isolated backend responses, not a
packaged launch or verification on another OS.

The UI follow-up replaces the long red explanation with a compact status icon
and short muted hint, reserves the feedback line's height and removes the manual
name-check retry control. The 13 form tests, desktop lint and desktop build pass;
the failure regression now verifies recovery by editing the name.
`artifacts/desktop-capture/run-OV2hwn/report.json` is **verified: true**, with 12
updated light/dark, pending/failure, keyboard and narrow reduced-motion captures,
no errors and two existing tracking-identity warnings. The light/dark duplicate,
failed-check and narrow PNGs were inspected.

### New task project menu (2026-10-27)

The header project button now opens the shared CDK dropdown menu directly,
replacing the second selector previously inserted above the task card. Choices
remain controlled by the workspace owner; selecting the current project keeps
the draft. Closing or deactivating the retained form releases its overlay.

Desktop lint, build and the full suite passed (101 desktop, 7 capture-tool and
362 renderer tests, including TypeScript contract checks). The native macOS
preview report at `artifacts/desktop-capture/new-task-project-menu/report.json`
has **verified: true** with eight checkpoints. It asserts unchanged dialog,
card, trigger and field geometry when opening/dismissing the menu, keyboard
selection, Escape/focus and draft retention, same-project selection and cleanup
on dialog close in both themes and narrow reduced-motion layouts. Light narrow
and dark wide PNGs were inspected. Existing Angular tracking-identity warnings
remain in the report; there are no capture errors. This verifies unpackaged
components with the isolated preview backend, not a packaged application.

### Per-backend workspace restoration (2026-10-28)

The connected workspace now saves project/task/session selection, navigation
filters/windows and side-panel tab, visibility and wider-review state independently
per backend and desktop window. Restoration reconciles bounded resource windows,
handles deleted resources and rejects stale replies. Archived/closed sessions
remain read-only; no creation, recovery or agent command is replayed. An initially
expanded panel receives focus so Escape works after reopening.

Desktop lint, production build and the complete suite pass (102 desktop,
7 capture-tool and 375 renderer tests, including TypeScript contract checks).
The native macOS Electron smoke passes through the real sandboxed bridge,
including persisted layout round trips and invalid-layout rejection. The disk
tests cover relaunch and backend/window isolation with legacy contexts retained.

`artifacts/desktop-capture/workspace-resume-final/report.json` is **verified: true**,
with six checkpoints, no errors and nine existing Angular tracking-identity
warnings. The scenario recreates the production owner with isolated saved backend
contexts, checks selected project/session, Browser/Changes tabs, open/closed and
wider panels, Escape/focus, both themes and narrow reduced-motion layouts. Light
wide, dark Browser and both narrow PNGs were inspected after transitions settled.
These are unpackaged macOS checks with controlled backend responses; no packaged
launch, live terminal/browser restoration or other OS runtime was verified.

The existing connected-workspace regression also passes at
`artifacts/desktop-capture/workspace-resume-connected-final/report.json`:
**verified: true**, 20 checkpoints, no errors and eight existing tracking-identity
warnings. Its submissions now await the commit-panel animation and asynchronous
project-name availability rather than racing them. The final first-project
handoff PNG was inspected, and the owned preview server was stopped.

### Restoration ownership refactor (2026-10-28)

`WorkspaceRestoration` now owns read-only resource reconciliation and numeric
keyset policy behind four named read operations. It has no Angular state or
mutation capability and returns immutable bounded windows. The store applies
results through the same hydration path used by normal navigation, reusing
already reconciled normal/archived session pages. The archive owner checks
scope/task lifetime before accepting a restored window and invalidates older
in-flight replies. Persistence remains separately owned by `WorkspaceResume`.
Public store/component APIs, saved data and platform contracts remain unchanged.

Direct coordinator tests cover bounded older-resource lookup, archived/deleted
sessions, paused setup, stale replies and read failures. Integration tests verify
that selected-session windows are not fetched twice and a superseded project
restoration cannot show an error after explicit navigation. Archive adoption tests
cover scope/task cleanup and earlier in-flight reads. The full desktop suite
passes: 102 desktop, 7 capture-tool and 383 renderer tests, including TypeScript
contract checks. Desktop lint, production build and native macOS smoke also pass.

`artifacts/desktop-capture/workspace-restoration-refactor-final/report.json` is
**verified: true** with six checkpoints, no errors and nine existing Angular
tracking-identity warnings. It checks reopened project/session selection, panel
tabs/visibility/wider review, Escape/focus, both themes and narrow reduced-motion
layouts using the production components with isolated backend data. Light Browser,
dark wider-review and dark narrow PNGs were inspected. The owned preview server
was stopped. No packaged launch or other OS runtime was verified.

### First backend opening (2026-10-28)

Workspace code now prefetches while Home is idle; only the selected candidate
mounts behind inert Home. Scoped navigation can prepare before opening. The
launcher requires the matching ready backend and a render acknowledgement after
two animation frames. Network replies do not gate that acknowledgement.
Candidate generations reject stale acknowledgements, including a rapid
cancel/reselect that retains the same Angular view. Pending frames are cancelled
on generation changes and destruction; lifecycle progress does not restart them.

A native Electron diagnostic against the production composition with isolated
backend replies recorded a 50ms worst first-opening frame interval before the
change, versus 18.5ms with the same diagnostic after preparation moved earlier.
The final regression at
`artifacts/desktop-capture/machine-first-open-pass/report.json` is **verified: true**:
seven checkpoints, no errors or warnings. It covers idle prefetch without mounting,
inert preparation without focus theft, rapid cancellation/reselection, first and
warm openings, an already-ready backend, reversals, keyboard focus and narrow
reduced motion in both themes. Final first-opening maxima were 33.4ms for the
light cancellation/reselection case and 17.6ms for dark ready-machine opening;
warm maxima were 18.5ms and 17.6ms. No long animation frames were observed inside
the sampled opening windows. These are host-dependent diagnostics, not an FPS
guarantee or a large live repository benchmark. Light first-opening and dark
narrow PNGs were inspected.

The existing full startup regression at
`artifacts/desktop-capture/machine-startup-pass/report.json` also passes with
16 checkpoints, covering preparation, updates, SSH trust/sign-in, connection
failure/recovery, validation, focus, themes and narrow layouts. Its stale Change
selector now uses the current title-island machine panel.

Desktop lint, production build, TypeScript contract checks and the full suite
pass: 102 desktop, seven capture-tool and 386 renderer tests. The native macOS
smoke passes through production `app://`, the sandboxed bridge and fixture HTTP;
it now requires the workspace to open and become interactive, beyond mounting.
No dependencies, production security settings or backend contracts changed.
These are unpackaged Electron checks with controlled backend data, not packaged
app, live SSH performance or other OS verification.

### Shared animation audit and running indicators (2026-10-28)

The broader native audit compares first/warm dropdowns, EaseSwap labels, Fold,
Presence, side-panel opening, panel tabs, task folds, new-task dialogs, project
creation morphs, settings sheets, machine dialogs and the title island. The
48-checkpoint light/dark report at
`artifacts/desktop-capture/animation-audit-final/report.json` is **verified: true**,
with no errors and ten existing Angular identity-tracking warnings. Recorded
rAF gaps were at most 18.8ms in these isolated sample windows; this does not
establish every animation's performance under arbitrary system load.

The audit found one persistent shared cost: StatusGlyph rotated an SVG path,
forcing Chromium to perform SVG layout on every animation tick. A bounded
20-task fixture with 39 running indicators measured 60 layouts and about 224ms
of renderer main-thread work during one idle second before the change.
Continuous rotation now belongs to the HTML host, with an inner HTML surface
preserving independent one-shot status effects. Timings, SVG drawing and public
inputs/labels remain unchanged; no permanent layer hints or runtime GPU flags
were added. Reduced-motion changes cancel active one-shot effects immediately
and the component removes its media listener on destruction.

The saved regression at
`artifacts/desktop-capture/status-motion-verified/report.json` is **verified: true**,
with eight checkpoints, no errors and twelve existing identity-tracking warnings.
Idle samples deliberately use no rAF loop, since that loop would itself request
main-thread frames. Both themes measured zero layouts and style recalculations,
with approximately 2.4ms/light and 6.7ms/dark main-thread work in one second.
First/warm task dialogs stayed below 18.5ms between sampled frames. The scenario
also checks native focus restoration, narrow reduced motion, HTML rotation
targets and resource-removal cleanup. Light sidebar and dark narrow PNGs were
inspected, along with the full light/dark status palette in Foundations.

The existing sidebar motion regression at
`artifacts/desktop-capture/sidebar-status-motion-verified/report.json` passes
**verified: true**, 64 checkpoints, no errors/warnings. It covers bulk insertion,
removal/reordering, interrupted reversals, status changes, session completion,
retained rows, collapsed groups and reduced motion in both themes.

Desktop lint, the production build, TypeScript contracts and the full suite pass:
102 desktop, seven capture-tool and 387 renderer tests. The added unit regression
checks immediate reduced-motion cancellation and listener disposal. The native
macOS production smoke also passes. These are unpackaged Electron measurements
with controlled backend replies, not packaged-app, live remote-agent or other OS
benchmarks. The shared bottleneck is fixed; the audit is not a universal FPS
guarantee. Dependencies, production security settings and backend APIs are unchanged.
