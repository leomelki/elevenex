# Component system verification

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
