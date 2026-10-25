# Desktop captures for agents

Run ordinary JavaScript against one real Angular renderer in native Electron.
Yield names to capture precise checkpoints. No Playwright, Chrome installation,
backend, accounts, production debugging hooks or new dependencies are required.
Use the Node version required by `apps/desktop/README.md`.

Omit `--fixture` to capture the normal product renderer through Electron main
and its sandboxed preload. For supplied-data component states, start
`pnpm desktop:preview` and pass `--url http://127.0.0.1:4310`. This uses the real
components under an isolated development entry. The explicit `--fixture` mode
only verifies this tool using a synthetic Angular component and never supplies
product visual evidence.

## Quick start

```sh
pnpm desktop:capture scripts/desktop-capture/scenarios/check.mjs --fixture
```

Or pass a disposable scenario through stdin, without creating a script file:

```sh
pnpm desktop:capture --fixture <<'JS'
export default async function* (capture) {
  await capture.waitFor(() => document.querySelector('ex-capture-fixture h1'));
  await capture.component('ex-capture-fixture', (component, state) => {
    component.count.set(state.count);
    component.status.set(state.status);
  }, { count: 42, status: 'Needs you' });
  yield {name: 'needs-you', inspect: ['[role=status]']};

  await capture.motion.freeze();
  await capture.click('#toggle');
  yield* capture.frames('opening', [0, 140, 280, 500, 1000], ['#panel']);
}
JS
```

Scenario paths resolve from the repository root. Saved modules can use normal
relative imports. Inline modules can import Node built-ins or absolute file
URLs; their code lives in memory and has no directory for relative imports.
Keep disposable files in ignored `artifacts/desktop-capture/scenarios/`. Only
reusable regression scenarios belong in `scripts/desktop-capture/scenarios/`.

Use `--out artifacts/desktop-capture/my-check` to choose an **empty** directory;
the default creates a unique run directory. Existing outputs are never replaced.
The CLI prints `CAPTURE_IMAGE`, `CAPTURE_REPORT` and `CAPTURE_GALLERY` paths.
Read `report.json` and require `verified: true` before claiming success. Use the
image-viewing tool on the relevant PNGs; embed images in chat when showing them
to the user. Artifacts are gitignored. Never use fixture images as evidence that
the product shell looks correct.

## Fast iteration

One invocation reuses the same Electron window, Angular app, state, fonts and
loaded assets across all its checkpoints. It recompiles main/preload/shared only
when their source/configuration/lockfile changes. It starts an Angular server
on an available loopback port and stops its owned processes on completion,
failure, Ctrl+C or the overall deadline (120 seconds by default).

For repeated invocations, keep Angular/HMR warm in a terminal:

```sh
pnpm desktop:capture:serve --fixture --port 4310
# In another terminal:
pnpm desktop:capture scripts/desktop-capture/scenarios/check.mjs --fixture --url http://127.0.0.1:4310
```

After the shell is available, omit `--fixture` from both commands, or reuse
`pnpm desktop:dev` with `--url http://127.0.0.1:4300`. The runner never stops a
server supplied with `--url`. Each invocation gets a fresh Electron profile and
storage, independent of the user's app. The persistent server keeps compilation
and asset caches warm; no persistent automation daemon or remote-debugging port
is opened. Stop the serve terminal when finished.

On the development Mac, a warm regression run captured eight states in about
1.8 seconds end-to-end; a warm one-shot stdin capture took about 0.6 seconds.
These are tool iteration measurements, not product frame-rate benchmarks.

`--built` uses the existing `apps/desktop/renderer` through the real `app://`
handler instead of starting Angular. Build the product first. Component state
access requires Angular development mode; production captures use input and DOM
inspection. This is an unpackaged native launch, not packaged-app validation.

## Define states using real code

The scenario runs in Electron **main** and can import Node's `assert` or local
scenario helpers. Functions passed to `evaluate`, `component`, and `waitFor`
execute in the renderer. They cannot close over scenario variables; pass data
as explicit arguments and return serializable results. Await operations in order.

| API | Behavior |
| --- | --- |
| `evaluate(fn, ...data)` | Execute a function in the renderer; return its serializable result. Promises and original error messages are preserved. |
| `component(selector, (component, data) => ..., data?)` | Find one real Angular component through its development debug API; call public methods, set signals, or inspect state. Apply change detection and settle afterward. No app-specific registry or global test hook is needed. |
| `waitFor(predicate, ...data)` | Retry a renderer condition for up to ten seconds. Prefer actual ready/empty/error selectors over sleeps. |
| `settle()` | Await fonts, decoded DOM images and two paint frames. Does not finish or advance paused animations; does not wait for network/business operations. |
| `click(css)`, `hover(css)` | Trusted Chromium mouse input. Clicks reject ambiguous, hidden, disabled or covered targets. Scroll off-screen targets into view explicitly. |
| `fill(css, text)` | Select an editable input/textarea and send trusted text input, including Unicode. |
| `press(key, modifiers = 0)` | Key down/up, with Tab/Enter/Escape support. Modifier mask follows CDP. |
| `theme('light' \| 'dark')` | Update native theme and `prefers-color-scheme`. Product code must own its `data-theme` update. |
| `reducedMotion(boolean)` | Set `prefers-reduced-motion`. |
| `viewport(width, height)` | Change content viewport at 1× CSS pixel scale. |
| `inspect(css[])` | Return layout boxes, computed styles, relevant attributes, focus, media and animation state. Up to 100 matches per selector. |
| `accessibility()` | Return the accessible Chromium tree (up to 2,000 nonignored nodes). It aids inspection; it is not a WCAG audit. |
| `cdp(method, params?)` | Raw Chromium command targeting this window. Use for wheel/drag/touch, advanced key events, or tracing, rather than growing action-specific tool handlers. |

Define feature states through the actual owning component or service methods,
then assert the resulting DOM. Prefer public domain operations over mutating
internal fields. Feature-specific fake data and providers belong in isolated
development/test entry points; do not add mock modes or evaluators to the
production bridge. The normal `git:status` currently returns the foundation's
existing stub; this tool does not implement repository or agent features.

Changing the route or selected task can launch asynchronous work. Await a
specific resulting state before yielding. For asynchronous error/loading states,
use a feature's real test provider or controlled promise rather than arbitrary
timeouts or screenshots of replacement HTML.

## Motion

The title island has complementary state and motion regressions:

```sh
pnpm desktop:capture scripts/desktop-capture/scenarios/title-island-states.mjs --url http://127.0.0.1:4310 --timeout 180
pnpm desktop:capture scripts/desktop-capture/scenarios/title-island.mjs --url http://127.0.0.1:4310 --timeout 180
```

They check every tone, machine/guest panel, keyboard and disabled focus, hover,
progress interpolation, long names and narrow containing regions, plus frozen
spring/blur frames, opening/closing, interruptions, reduced motion and the actual
workspace title-bar composition, in both themes.

Two reusable component regressions run against `pnpm desktop:preview`:

```sh
pnpm desktop:capture scripts/desktop-capture/scenarios/sidebar-motion.mjs --url http://127.0.0.1:4310 --timeout 180
pnpm desktop:capture scripts/desktop-capture/scenarios/git-motion.mjs --url http://127.0.0.1:4310 --timeout 180
```

The current machine onboarding regression uses the same preview:

```sh
pnpm desktop:capture scripts/desktop-capture/scenarios/machine-onboarding.mjs --url http://127.0.0.1:4310 --timeout 180
pnpm desktop:capture scripts/desktop-capture/scenarios/machine-motion.mjs --url http://127.0.0.1:4310 --timeout 180
```

It checks first run, card preparation, SSH host/key keyboard flow, pairing,
failures, last selection, launch/return, open-machine updates, search/empty state,
both themes, reduced motion and a narrow dialog with restored focus. The focused
motion scenario measures card/trigger origins, uniform view scaling, interrupted
launch/modal reversals and focus after reopening, in both themes.

The Browser state regression uses the same preview:

```sh
pnpm desktop:capture scripts/desktop-capture/scenarios/browser-view.mjs --url http://127.0.0.1:4310
```

It checks target alignment at full, phone and 440px panel widths, cursor
interpolation, takeover/hand-back, needs-you, point-and-ask focus restoration,
and reduced motion in both themes. Its checkout data stays in the preview.

The Changes review regression also runs against the component preview:

```sh
pnpm desktop:capture scripts/desktop-capture/scenarios/changes-review.mjs --url http://127.0.0.1:4310 --timeout 180
```

It checks compact/wide layouts, exact code whitespace, line gutters, wrapping,
keyboard file selection and focus restoration, full-file reading position,
loading/error/deleted/empty states, Viewed folding and a virtualized 1,000-file
list in both themes. Its supplied content stays outside production.

Run them sequentially so another Electron capture window does not throttle the
one being measured. They sample in the renderer before mutation and at each real
animation frame, then continue through retained-row and animation cleanup.
Each final checkpoint includes the complete probe in its report metadata.
They check both themes and reduced motion, first-paint/settled continuity, stable
identities, and interrupted changes. Bulk sidebar travel can be large while
remaining continuous; sampled frame times and speeds distinguish that movement
from an abrupt boundary jump. A long frame interval is reported separately from
the component's motion curve; these checks are not a general FPS benchmark.

Freeze **before** triggering an action, then seek each CSS/WAAPI animation to a
known age in milliseconds. Named screenshots preserve the frozen frame:

```js
await capture.motion.freeze();
await capture.click('#toggle');
await capture.motion.seek(500);
const halfway = await capture.inspect(['#panel']);
yield {name: 'halfway', inspect: ['#panel'], metadata: {halfway}};
yield* capture.frames('opening', [750, 1000], ['#panel']);
await capture.motion.finish();
await capture.motion.play();
```

`freeze()` sets Chromium's animation playback rate to zero. `seek(ms)` gives
each currently tracked CSS transition/animation/WAAPI animation that elapsed
age, including its delay; it rejects when no animation exists. Use one action
per sample sequence. New animations created at different times are not a shared
simulation clock. `finish()` completes finite document animations, leaving
infinite loops alone. `play(rate = 1)` resumes browser animation time.

To inspect frame-to-frame movement in real time:

```js
await capture.motion.play();
await capture.click('#toggle');
const probe = await capture.measureMotion(['#panel'], 600);
yield {name: 'after-motion', metadata: {probe}};
```

The bounded rAF probe returns sampled rectangles, the largest displacement
between samples, and the longest observed frame interval. Compare against the
component's expectations in a scenario assertion. Sampling starts when called;
it is diagnostic, not a full profiler or an FPS guarantee. Use raw CDP tracing
when investigating performance in depth.

JavaScript timers, `Date`, network responses, canvas rendering, View Transition
pseudo-elements and agent processes are **not** made deterministic by animation
scrubbing. Drive their state explicitly, or record live behavior using CDP.
No MP4 encoder is included; screenshot sequences are cheap, directly inspectable
filmstrips. Screenshots capture web content, excluding native OS title-bar buttons.

## Output and failures

Every checkpoint yields a numbered PNG plus `.json` (layout/state/focus) and
`.a11y.json`. `index.html` compares images, links to snapshots, and shows errors;
`report.json` records timings, theme, viewport, metadata and verification status.
Yield `{name, selector}` for an element crop, `{name, inspect: [...]}` for targeted
diagnostics, or a string for a full viewport screenshot. Names must be unique,
contain only letters/digits/`-`/`_`, and be at most 80 characters.

Assertions, uncaught renderer exceptions, console errors and failed resources
fail the run. Warnings are retained. Caught scenario evaluation failures can be
asserted without being mistaken for uncaught product errors. Completed images,
diagnostics and a best-effort `failure.png` survive failure. Startup errors also
write a failed report. A hard OS kill can interrupt artifact writes.

Results are bounded to 300 checkpoints per run, 200 errors and 200 warnings,
120 frames per sample sequence, and 64 KiB of checkpoint metadata. Split larger
investigations into focused scenarios. Do not dump an entire repository or long
chat transcript into inspection output.

## Ownership and checks

- `cli.mjs`: composition, options/stdin, cancellation, isolated temporary profile
  and run-level results.
- `processes.mjs`: owns launched child processes and idempotent shutdown. It never
  registers global signal handlers or stops processes it did not launch.
- `compilation.mjs`: main/preload/shared compilation and source freshness checks.
- `renderer-server.mjs`: Angular startup/readiness, token synchronization and
  explicit reuse of an existing server.
- `apps/desktop/test/capture-runner.cjs`: tool-only Electron entry. Loads the
  unchanged production main/preload, owns the capture lifetime and saves failures.
- `scenario.mjs`: scenario iteration and checkpoint artifact writing.
- `driver.mjs`: stable scenario API, renderer evaluation, Angular state and native
  media settings. It composes capability modules and disposes them in order.
- `connection.mjs`: debugger attachment and bounded renderer diagnostics.
- `input.mjs`: trusted input, target validation and element geometry.
- `motion.mjs`: owns animation subscriptions, playback and frame/layout probes.
- `inspection.mjs`: self-contained renderer callback for bounded DOM snapshots.
- `options.mjs` / `report.mjs`: validation and escaped standalone gallery.
- `apps/renderer/capture/`: explicit Angular fixture configuration, outside the
  product source/build graph. No design-system implementation is implied.

Extend the module that owns a behavior; keep browser input out of startup code
and artifact writing out of page evaluation. Capability modules receive their
page/connection dependencies explicitly and must not import the CLI or create a
second window. Keep scenario-facing methods stable through `Capture`; its small
delegations intentionally preserve the public API. Renderer callbacks are
serialized into the page, so they must be self-contained and cannot close over
module imports. Prefer extending a reusable scenario for feature-specific setup
over adding feature-specific branches to the runner. The Angular fixture already
separates its component behavior, template, and styles; keep it synthetic.

`pnpm desktop:test` runs existing IPC/security/type/Angular tests and capture
validation/lifecycle tests. `pnpm desktop:lint` includes this tool and fixture templates.
Run the native regression command above after changing automation behavior.
It checks signal updates, trusted text and Tab focus, rejected interactions,
CSS and WAAPI midpoint sampling, frozen frame stability, both themes, reduced
motion, resizing, cropping and layout probes, using the real sandboxed preload.
It intentionally remains opt-in because it launches a native window.

Automation code is absent from `src/` and from electron-builder's `dist/` and
`renderer/` inputs. Production still exposes exactly `window.elevenex`; no raw
IPC, generic evaluator, remote-debugging endpoint, security relaxation, or
capture flag is introduced. Local scenario modules are trusted executable code.
