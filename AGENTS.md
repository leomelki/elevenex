The project must support repositories with thousands of files and folders, hundreds of branches, and hundreds of commits per hour continuously arriving on `origin/main`.

## Repository scope

- The product hierarchy for the new desktop is **project → task → sessions**. A task owns a git branch and an isolated workspace; sessions are agent conversations within that task.
- The existing application (`apps/frontend`, `apps/backend`, `apps/electron`) remains active. The new desktop foundation lives alongside it in `apps/renderer`, `apps/desktop`, and `packages/shared`.
- Preserve the existing app's commands, dependencies, and behavior when working on the new foundation. Root `pnpm dev` runs the existing app; root `pnpm desktop:*` commands run the new foundation.
- The **Frontend UI** section below applies to the existing `apps/frontend`. The new renderer follows **New desktop foundation** instead, including its component-library and theme rules.
- Read the relevant package manifests, nearby implementation, and tests before changing code. See `apps/desktop/README.md` for the new app's setup and IPC workflow. Check nested `AGENTS.md` files for more specific instructions.

## Working practices and tools

- Use `rg` and `rg --files` for bounded searches. Inspect `git status` and the relevant diff before editing; preserve unrelated and uncommitted changes.
- Use the repository's pnpm workspace and lockfile. Do not introduce npm/yarn lockfiles, upgrade the global toolchain, or migrate the existing app incidentally.
- Before a dependency upgrade, verify stable versions and peer/engine compatibility against the registry and official documentation. Read the package's `engines` and the Angular compatibility table; do not assume the newest TypeScript major is supported.
- Ask before adding a direct dependency outside the user's approved stack. Previously authorized dependencies do not need approval again. Prefer existing tools and Node's built-in APIs when they meet the requirement.
- Use the Angular CLI and the installed Angular build/test tools for renderer changes, TypeScript for contract checking, ESLint for linting, and electron-builder for packaging. Do not add a second build or test system to solve a local configuration issue.
- Prefer official framework/platform documentation for unfamiliar APIs. Inspect locally installed types and schemas to confirm the exact APIs supported by the locked versions.
- Use focused patches. Change source files rather than generated output; review lockfile changes for unintended upgrades to other workspace packages.
- Keep code explicit and small. Use descriptive domain names, strict types, and clear ownership. Avoid `any`, unexplained casts, blanket lint suppressions, and abstractions that only wrap one trivial operation.
- Split modules by responsibility as they grow. Extract an abstraction when it represents a real boundary or removes meaningful duplication; avoid speculative frameworks, generic repositories, or a service for every function.
- Document why a non-obvious constraint exists, especially security decisions and dependency overrides. Keep setup instructions accurate when commands or architecture change.
- Run the checks appropriate to the changed area. Report what passed, what could not run, and why; distinguish a smoke test from a packaged-app launch or visual verification.

### Modularity and maintainability

- Organize code around cohesive responsibilities and domain ownership. Keep CLI entry points, Electron bootstrap, routes, and IPC adapters focused on composition; move substantial behavior into named modules with explicit inputs and outputs.
- Keep feature orchestration and shared state separate from reusable presentational components. Components should expose small, typed inputs/outputs and own their local interaction state; platform calls belong behind the existing application boundaries.
- Prefer composition and explicit dependencies. Make resource ownership visible: the creator of a process, observer, timer, subscription, or debugger attachment must provide and invoke its cleanup path. Avoid module-level mutable state for reusable behavior.
- Reuse existing components and domain operations before duplicating them. Extract shared behavior when it has a clear responsibility or meaningful repeated use; keep feature-specific code near its feature. Do not create generic helpers, inheritance trees, or one-function services solely to increase the file count.
- Split a module when it mixes unrelated reasons to change, rather than enforcing an arbitrary line limit. A stable public API may delegate to focused internal modules so callers do not need to know their implementation structure.
- Keep substantial Angular behavior, templates, and styles in their respective component files. Document module boundaries and extension points when adding tooling or a feature, and keep that documentation current during refactors.
- Validate refactors through public behavior and ownership boundaries, including cleanup and failure paths. Preserve supported APIs unless changing them is part of the task; avoid tests tied to private method names or file layout.

## New desktop foundation

### Ownership and dependency direction

| Location | Owns |
| --- | --- |
| `apps/renderer` | Angular views, routing, UI state, and calls to the typed preload bridge |
| `apps/desktop` | Electron lifecycle, windows, OS integration, IPC handlers, and privileged operations |
| `packages/shared` | Serializable domain types, IPC request/reply/event contracts, and public bridge types |
| `scripts/desktop-shell.mjs` | Development orchestration, compilation, checks, and packaging commands |

- Both apps may depend on `packages/shared`; shared code must not depend on either app, Angular, Electron, or Node runtime APIs. Keep this package focused on contracts rather than turning it into a miscellaneous utility collection.
- The renderer must not import Electron, Node built-ins, desktop implementation files, or the existing backend. Git, filesystem access, process execution, and agent supervision belong in the main process or workers.
- Keep main-process bootstrap and IPC adapters thin. When behavior grows, move domain operations into focused modules with explicit inputs and results; keep Electron-specific objects at the boundary.
- Treat application state as owned data with defined lifetimes. Do not use a mutable global singleton to share unrelated state across windows or tasks. Clean up subscriptions, watchers, timers, and child processes with their owning window, task, or application.
- Build only the requested foundation or feature. Do not port existing product features, introduce a backend server, or add a persistence framework without a concrete requirement.

### Angular renderer

- Use standalone components, strict TypeScript and templates, Signals, and zoneless change detection. Use `computed` for derived state; reserve `effect` for actual side effects rather than copying state between signals.
- Keep local view state in the owning component. Introduce a focused service when state or behavior has a shared lifetime. Keep IPC calls and platform integration out of templates and presentational components.
- Use lazy router routes and enable View Transitions. Keep the production router on history mode through `app://`; do not work around protocol problems by switching to hash routing.
- Separate substantial behavior, markup, and styles into `.component.ts`, `.component.html`, and `.component.css` or `.component.scss`. Inline templates/styles are for genuinely small components.
- Use Angular CDK for overlays, focus management, and eventual virtual scrolling. Do not add Zard, Angular Material, Spartan, `@angular/aria`, or another component library to the new renderer until authorized. The legacy app's Zard/Tailwind rules do not require adding those dependencies here.
- Do not add `zone.js` or `@angular/animations`. Use plain CSS, the Web Animations API when needed, and Angular `animate.enter` / `animate.leave` for entry and exit.
- Prefer native semantic controls. Provide accessible names, keyboard operation, visible focus, and correct disabled/loading states. Overlays must manage focus and restore it on close; hidden panels must not leave focusable controls in the tab order.
- Use Angular lifecycle cleanup such as `DestroyRef` or `takeUntilDestroyed` for long-lived subscriptions. Keep async requests cancellable or reject stale replies when the selected task/session changes.

### Finding and using renderer components

- Start with [the renderer component guide](apps/renderer/README.md) for architecture, composition slots, ownership and preview instructions. Read the owning family's README and `index.ts`, then the component's signal inputs, outputs, template and nearby tests before using or extending it. The Angular implementation defines the current API; `docs/design-system/project/components/<Name>/README.md` describes the intended design and interaction. Reference React/gallery code is not application code.
- Find existing components before building another control. Search within the relevant family, for example `rg --files apps/renderer/src/app/ui` or `rg -n 'DropdownComponent|ex-dropdown' apps/renderer/src/app apps/renderer/preview`. Design names use PascalCase, source filenames use kebab-case, and selectors generally use `ex-`; native-button enhancements such as `button[exButton]` are exceptions.

| Need | Implementation and usage guide |
| --- | --- |
| Buttons, icons, choices, status, feedback, tooltips and motion | `apps/renderer/src/app/ui/index.ts`; see `ui/icon/icon-paths.ts` for available icon names |
| Single-choice dropdowns and action menus | [Dropdown guide](apps/renderer/src/app/ui/dropdown/README.md), exported by `ui/dropdown` and `ui` |
| Modal dialogs, settings sheets and setting rows/fields | [Sheet guide](apps/renderer/src/app/ui/sheet/README.md), exported by `ui/sheet` and `ui` |
| Project rail, task/session outline, lifecycle, branches/workspaces, git actions and panel tabs | [Task guide](apps/renderer/src/app/tasks/README.md), exports in `tasks/index.ts` |
| Project creation, appearance, project menus and repository settings | [Project guide](apps/renderer/src/app/projects/README.md) and [settings guide](apps/renderer/src/app/projects/project-settings/README.md), exports in `projects/index.ts` |
| Chat, turns, Markdown, composer, presets and decision cards | [Conversation guide](apps/renderer/src/app/conversation/README.md), exports in `conversation/index.ts` |
| Machine home, onboarding, launch and title island | [Machine guide](apps/renderer/src/app/machines/README.md), exports in `machines/index.ts` |
| Changes review/list, Browser and Terminal frames | [Side-view guide](apps/renderer/src/app/views/README.md), exports in `views/index.ts` |
| Shell regions and workspace composition | `apps/renderer/src/app/shell/app-shell.component.*` and `apps/renderer/src/app/workbench/workbench.component.*`; projection slots are documented in the renderer guide |

- Import standalone components and their readonly view models from the relevant family's public barrel using relative paths, and add the components/directives to the consuming component's `imports`. Keep family-internal helpers private unless they represent a supported reusable API. Renderer view models stay in their family; serializable platform contracts belong in `packages/shared`.
- Supply readonly data and handle typed intent outputs in the owner. Apply controlled values explicitly after an action succeeds; children own unfinished drafts, disclosures and local selection. Use two-way binding only for documented model inputs. Preserve stable IDs in keyed lists and replace changed objects/collections so OnPush and Signals receive updates. Platform operations, busy/error state, cancellation and stale-response checks belong to the integrating container.
- Reuse the existing primitives: `<button exButton variant="primary">Create task</button>` for native actions, `<ex-icon-button icon="panel" label="Toggle side panel" (pressed)="togglePanel()" />` for icon actions, and `exTooltip` for control tooltips. `IconComponent` is decorative; the owning control needs its accessible name. Use the shared status, feedback and choice components rather than reproducing their markup and styles.
- Use `DropdownComponent` for ordinary controlled single choices. Compose `DropdownMenuComponent` with `exDropdownItem`/`exDropdownRadio` and CDK menu triggers for custom action menus. Searchable branch/preset pickers and forms remain specialized dialogs; menus must not contain arbitrary form controls. Supply bounded option windows.
- Use `ModalLayerComponent` for custom modal boundaries and `SheetComponent` with the exported settings controls for settings surfaces. Follow the sheet guide for labels, projection, focus and trigger origins. Retain the layer and its projected data during exit, drive its `open` input, and deactivate retained interactive children as closing begins. Let the layer own focus trapping/restoration and background recession.
- Reuse `FoldComponent`, `AutoHeightDirective`, `PresenceComponent`, `EaseSwapComponent`, `FlipDirective` and `FittedHighlightDirective` where their existing behavior fits. Read the renderer guide's motion rules before combining them; preserve keyed identities, reduced-motion behavior and resource cleanup rather than adding competing animations.
- Run `pnpm desktop:preview` and open `http://127.0.0.1:4310` to exercise real component APIs. `apps/renderer/preview/*-demo.component.ts` and their templates are working composition examples. Keep fixtures and synthetic activity under `preview/`, outside the production import graph. When changing a public component API, update its barrel as needed, family guide, preview consumers and relevant tests together. Verify UI changes through the desktop capture workflow below, using `--url http://127.0.0.1:4310` when capturing the preview.

### Design system and motion

- Before writing UI, read `docs/design-system/project/README.md`, especially Motion, and inspect `project/tokens.css`. If these inputs are missing, request them and continue independent infrastructure work; do not invent replacement brand tokens or claim the designed UI is complete.
- `docs/design-system/project/tokens.css` is authoritative. The build copies it verbatim into `apps/renderer/src/design-system/tokens.css`; edit the source rather than the generated copy.
- Use the supplied tokens for colors, spacing, radii, typography, durations, and easing. Do not copy the legacy frontend's palette or scatter hard-coded alternatives through components.
- Follow the system theme with `prefers-color-scheme` and a `data-theme` attribute on `<html>`, including native theme updates through the bridge. Do not introduce the legacy app's `.dark` theme model into this renderer.
- Bundle Instrument Sans and Geist Mono locally, retain their licenses, and use their local files. Do not load fonts from a CDN at runtime.
- The requested shell has a title bar with a centered non-draggable island, a 56px project rail, 272px sidebar, main chat region, and closable 440px side panel. Use glass regions on the canvas with 8px gutters. Animate panel width with `dur-slow` and `ease-in-out` tokens.
- Respect `prefers-reduced-motion`. Keep motion purposeful and avoid animating large lists or triggering expensive layout work during unrelated updates.
- Check modified UI in light and dark mode, including contrast, focus, hover, disabled/loading/empty states, and open/closed panels. Capture the actual new renderer when verifying it; a screenshot of the legacy app is not evidence for this shell.

### Electron and IPC security

- Keep `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, and web security enabled. Do not add `remote`, enable webviews, or disable security to fix an integration problem.
- Expose exactly one narrow, typed bridge: `window.elevenex`. Use named operations; never expose raw `ipcRenderer`, Electron event objects, generic channel dispatch, arbitrary shell commands, or unrestricted filesystem access.
- Define every request's arguments and reply in `InvokeContracts`, every event payload in `EventContracts`, and public methods in `ElevenexBridge`. Implement both ends with the typed helpers; avoid parallel handwritten channel definitions.
- TypeScript types are not runtime validation. Main handlers must verify the sending window/main frame and origin, validate arguments, and enforce operation-specific path/resource permissions before privileged work.
- Event subscriptions must hide Electron's event object and return an unsubscribe function. Keep IPC payloads serializable and bounded; do not send process handles, Electron objects, secrets, or entire repository snapshots.
- Keep production CSP restrictive, with nonces for Angular's injected styles. Do not add production `unsafe-inline`, `unsafe-eval`, wildcard network access, or CSP bypass privileges. Scope any necessary development allowances to development only.
- Serve production assets through the privileged `app://` protocol. Preserve route fallback, MIME types, path/symlink confinement, and proper missing-asset errors. Do not replace it with `file://`.
- Prevent untrusted navigation and redirects; allow only validated external HTTP(S) links in the system browser. Deny permissions by default and grant new capabilities only for a defined feature.
- Ignore renderer development-URL overrides in packaged builds. Keep any test hooks and debugging capabilities out of the production bridge.
- Preserve native macOS window buttons, Windows/Linux title-bar overlay, draggable title-bar areas, and non-draggable interactive controls. Support multiple windows and restore valid on-screen bounds using asynchronous persistence.

### Performance and process lifecycle

- Design for thousands of repository entries, frequent incoming commits, and hundreds of branches. Use bounded/paginated results and incremental updates instead of full rescans or complete history reloads after each event.
- Use asynchronous filesystem, git, process, and network APIs in Electron main. Move expensive CPU work or long-running agent supervision to workers or utility processes as the need arises.
- Coalesce duplicate in-flight work, debounce noisy file events, and guard against stale results after navigation, workspace changes, or window closure. Cancellation and cleanup must be part of the operation's ownership.
- Execute programs with explicit argument arrays and an explicit workspace directory. Avoid interpolating user-controlled paths, branches, or prompts into shell commands. Handle process errors, cancellation, exit status, output limits, and shutdown cleanup.
- Keep app data separate from the existing Elevenex app. Do not write mutable application state into a checkout or packaged application resources.

### Validation and delivery

- For the **new desktop**, use `pnpm desktop:capture` and read `scripts/desktop-capture/README.md` for precise state setup, trusted input, animation scrubbing, PNGs and layout/focus/accessibility diagnostics. Prefer disposable stdin async-generator scenarios; reuse a warm Angular server with `--url` for iteration. Await actual UI conditions, inspect the resulting PNGs, and require `report.json` to say `verified: true`. Use `--fixture` only to verify the tool, never as product visual evidence. Keep feature mocks isolated from production and never add capture capabilities to `window.elevenex`. The legacy `screenshot:ui` command targets `apps/frontend`, not this renderer.

- From the repository root, use `pnpm desktop:lint`, `pnpm desktop:test`, and `pnpm desktop:build`. `pnpm desktop:dev` starts the new app; `pnpm desktop:package` packages it. The standard command names are also available in `apps/desktop`.
- Keep Angular's default test runner. IPC type tests must also run through `tsc`; a transpile-only test runner cannot verify negative type assertions. Include runtime tests for security boundaries, payload handling, and event cleanup when changing them.
- Add focused regression tests for meaningful behavior changes. Do not add brittle tests that mirror implementation details or unrelated tests for a documentation-only edit.
- For Electron/preload/protocol changes, use `apps/desktop/test/electron-smoke.cjs` with the installed Electron after building. Disable inherited `ELECTRON_RUN_AS_NODE` when launching the native app; do not weaken security settings to make the smoke test pass.
- Verify renderer HMR and main/preload restart behavior after development-runner changes. Stop the processes you started when validation ends.
- Packaging uses electron-builder. Verify the artifact on the host OS; do not claim Windows or Linux runtime verification from macOS builds. A successful compilation or unpackaged smoke test does not establish that the packaged app launches.
- Before delivery, review `git diff --check`, the source diff, and dependency changes. State any missing design inputs or blocked checks explicitly and leave unrelated files alone.

## Commits

- Follow the commit convention in `COMMIT_CONVENTION.md`.
- Use Conventional Commits in the form `feat(scope): description` whenever a scope is applicable.

## Frontend UI (existing `apps/frontend`)

- Use Zard UI components and Tailwind CSS utilities as much as possible when building or modifying frontend UI.
- When a needed Zard UI component is not already installed, do not hesitate to install the relevant component instead of hand-rolling a replacement.
- When a user asks to see an Elevenex UI change, use the repository skill at `.agents/skills/elevenex-screenshot/SKILL.md`. Its single capture command starts or reuses the app, verifies the requested state, saves the PNG in the repository, and returns the absolute path to embed in chat.

### Angular component organization

- Keep Angular components split by responsibility when they are more than trivially small: use `.component.ts` for behavior and wiring, `.component.html` for substantial templates, and `.component.scss` for substantial component styles.
- Inline `template` and `styles` are acceptable only for very small, self-contained components where the markup and styling are brief enough to read comfortably inside the TypeScript file.
- Prefer Zard UI components and Tailwind utilities for styling. Use component SCSS sparingly, only when utilities would be impractical or noisy, such as host selectors, third-party/rendered markdown/document styling, or edge-case component states. If styling or markup is reusable, create or extract an Angular component that owns the Tailwind/Zard implementation instead of sharing CSS rules across duplicated HTML.

### Dark mode and color best practices

- Dark mode is class-based. The app toggles the `dark` class on the root `html` element, and Tailwind dark variants should be written for that model.
- Prefer semantic design tokens from `apps/frontend/src/styles.css` over hard-coded colors. Use tokens such as `background`, `foreground`, `card`, `popover`, `primary`, `muted`, `accent`, `border`, `input`, `destructive`, `success`, and `warning`.
- When a color needs to be shared between light and dark mode, add or reuse a CSS variable in `styles.css` and map it through `@theme inline` when Tailwind utilities need it.
- Avoid mixing component colors with literal `white`, `black`, `slate-*`, or fixed hex values for normal app surfaces. Use `var(--surface-tint)` and `var(--surface-shade)` in `color-mix()` when a lightening or darkening endpoint is needed.
- Status UI should use semantic tokens: success for active/complete states, warning for pending/attention states, destructive for errors or dangerous actions, and muted for inactive states.
- Keep terminals and embedded code/editor surfaces intentionally dark only when that is a product decision. Otherwise, derive wrappers, labels, borders, and loading states from the theme tokens.
- Every new or modified UI surface should be checked in both light and dark mode. Verify readable contrast, visible focus rings, borders that do not disappear, hover/active states, disabled states, empty states, dialogs, and loading skeletons.
- Do not solve dark mode with one-off `dark:` patches if a semantic token would make the component consistent everywhere.

## Database (apps/backend)

- **ORM**: Drizzle ORM with better-sqlite3
- **Schema files**: `apps/backend/src/database/schema/*.schema.ts`, re-exported from `index.ts`
- **Migrations**: SQL files in `apps/backend/drizzle/`, auto-applied on app startup via `drizzle-orm/better-sqlite3/migrator`
- **No manual setup required**: The database and all tables are created automatically when the backend starts for the first time

## Backend async and process handling

- Prefer async Node APIs and libraries for filesystem, process, shell, git, and network operations whenever practical.
- Avoid blocking the backend main thread with synchronous calls such as `execSync`, `spawnSync`, `readFileSync`, heavy CPU loops, or large synchronous directory scans in request handlers, WebSocket paths, startup hot paths, and polling loops.
- When synchronous work is unavoidable, keep it small and isolated, and document why an async alternative is not suitable.
- For expensive or slow operations, use async flows with in-flight request coalescing, cancellation/cleanup guards, and stale-response checks so repeated UI refreshes or reconnects do not launch duplicate work or apply old results.

### When modifying the database schema

1. Edit or create schema files in `apps/backend/src/database/schema/`
2. Run `pnpm drizzle-kit generate` from `apps/backend/` to generate a new migration file
3. Commit the generated migration file in `apps/backend/drizzle/` alongside the schema change
4. The migration will be applied automatically on next app startup

**Do not** use `drizzle-kit push` in this project — always generate migration files so they are tracked in git and applied consistently across environments.
