# Renderer component system

Standalone Angular components, Signals, OnPush change detection and plain token CSS.
The production renderer contains no example projects, agent output, repository
services or synthetic activity. It starts on machine Home, then opens the
connected workspace through the typed backend bridge. Existing
frontend/backend/Electron commands retain their original behavior.

## Try the components

```sh
pnpm desktop:preview
```

Open `http://127.0.0.1:4310`. The workspace preview composes real components;
Foundations, Tasks, Projects, Settings, Sub-tasks, Git helpers, Conversation, Agent picker, Machines and views, and Machine flow exercise their public
APIs. Example data lives only in `preview/`, under a separate Angular build
configuration. It is absent from the production entry graph and packaged app.

The **Sidebar motion** and **Git motion** pages exercise repeated/bulk changes
and interrupted transitions through the real components. Sidebar controls include
keeping only the original fourth task, or the fourth and seventh, and 100-task
batches. Git controls cover Commit → Committing → Push → Pushing → Up to date.

Use `pnpm desktop:dev` for the normal native application. Checks are
`pnpm desktop:lint`, `pnpm desktop:test`, and `pnpm desktop:build`.
Visual verification uses [the native capture runner](../../scripts/desktop-capture/README.md),
with `--url http://127.0.0.1:4310` when reviewing the component preview.
See [verification results](VERIFICATION.md) for checks and captured states.
See [the design review](DESIGN_REVIEW.md) for corrected defects and remaining
differences from the supplied component and motion specifications.

## Boundaries

| Folder | Responsibility | Public API |
| --- | --- | --- |
| `src/app/ui` | Native actions, glyphs, feedback, choices, tooltip, motion | `ui/index.ts` |
| `src/app/tasks` | Projects, task lifecycle, branch/workspace choice, sidebar, git and panel tabs | [Task APIs](src/app/tasks/README.md) |
| `src/app/projects` | Project creation, appearance, project menu, settings and confirmations | [Project APIs](src/app/projects/README.md) |
| `src/app/conversation` | Messages, turns, work evidence, decisions, composer, presets, Markdown, scroll | [Conversation APIs](src/app/conversation/README.md) |
| `src/app/machines` | Machine home, connection steps, title island, launch transition | [Machine and view APIs](src/app/machines/README.md) |
| `src/app/machines/application` | Production startup, machine selection and platform integration | [Production flow](src/app/machines/application/README.md) |
| `src/app/views` | Changes review, change list, Browser and Terminal frames | `views/index.ts` |
| `src/app/shell` | Four-region layout and native/system theme subscription ownership | `AppShellComponent` |
| `src/app/workbench` | Supplied-data composition and connected side-view shells | `WorkbenchComponent` |
| `src/app/workspace` | Connected project/task navigation, creation, settings and task git state | [Workspace ownership](src/app/workspace/README.md) |
| `preview` | Interactive examples and composition fixtures | Separate development entry |

Feature barrels export components and readonly view models. Import from the
family you need; there is no all-features module or mutable global store.
Serializable IPC contracts remain in `packages/shared`; renderer-only view
models and DOM interaction state stay in the renderer.

## Inputs and outputs

An owner supplies readonly data. Children emit intent and retain only unfinished
interaction state: an open menu, draft, disclosure, current wizard step, or local
selection. Outputs do not secretly execute git, spawn agents, write files, copy
to the clipboard, or initiate network requests. For example, `Composer.submitted`
emits `{ text, intent, context }`; `DiffReview.fileRequested` emits the file's
identity, revision and requested mode. The future application controller owns
those operations, their busy/error state and cancellation.

Pass stable IDs when updating task/session/message/file lists. Replace changed
objects or collections rather than mutating an input in place. Diff responses
must match file ID, revision and review mode. `draft` and selected workspace
controls expose model inputs where two-way binding is useful. Most actions
remain controlled: apply the emitted value explicitly so loading, rejection and
optimistic updates have a clear owner.

Substantial templates and styles are beside their owning component. Tiny marks
and native-control wrappers use inline templates. Shared primitives are small
standalone imports, not feature services. Browser and Terminal expose projection
slots for a future trusted platform adapter; their controls emit typed requests.
No browser/terminal backend or unrestricted embed was added.

## Composition

`AppShellComponent` lays out five named slots: `shellTitle`, `shellRail`,
`shellSidebar`, `shellMain`, `shellPanel`. Its `panelOpen`, `wideReview`, and
`panelLabel` inputs control layout without changing feature data. The side panel
remains mounted and inert while closed; wider review makes the covered main
region inert and restores focus when it exits. Rail and sidebar keep their place.

`WorkbenchComponent` composes project/task navigation around supplied content.
Use `workbenchConversation` and `workbenchPanel` slots, readonly `projects` and
`tasks`, and its selection models. A platform container can replace this route
without modifying the reusable component families.

Bind `Workbench.wideReview` with the projected review's `wide` input/output to
activate shell takeover; Escape resets it through the shell. Handle
`closedTasksRequested` to open the closed-task list in the application owner.

The production `MachineWorkspaceComponent` composes `AppShell` with
`titleBar=false`, since `MachineApp` already owns the native title island.
The connected workspace code prefetches during idle time. Only the selected
candidate mounts, behind inert Home, before launch; its first render crosses a
paint boundary before opening starts. Its scoped feature
stores supply the existing presentational components; they never import the
legacy renderer or contact the backend directly. The five side views currently
provide tabs, close and expansion behavior with placeholder contents. Expansion
is available on every view and stays active when switching tabs.
`/connected-workspace` exercises this production composition with a typed,
preview-only backend adapter. Its fixture never enters the production build.

## Motion and accessibility

- Task session caps use internal pixel-height scroll batches, with bottom-aligned
  rows and an 18px masked edge while moving. Reveal/close durations follow travel
  distance (440–760ms); closing batches share the total travel duration. Settled
  batches release clipping, and reduced motion settles instantly. Fold's older
  opt-in `unroll` API remains available for compatibility; caps no longer use it.
- `FoldComponent` animates unknown height in place, preserves local state,
  releases clipping after settling, and makes closed descendants inert.
- `AutoHeightDirective` observes one inner wrapper and eases meaningful height
  changes. Give that inner wrapper the same gap/direction as its content.
- `FlipDirective` captures painted positions before keyed children update and
  animates only elements in its own `data-flip-scope`. Nested session scopes do
  not get transformed twice. Sidebar scopes use reordering only: Fold already
  moves neighbours continuously when their space opens or closes.
- `ListPresence` retains removed task/session identities until Fold closes their
  space. Returning a key during its exit preserves that component's local state.
  Gaps, stage headings, empty state and Closed count live inside folding rows.
  The owner releases its scheduled frame, cleanup timer and media listener.
- `PresenceComponent` uses Angular `animate.enter`/`animate.leave`; `EaseSwap`
  retains a control while its text fades and its width eases.
  Plain labels use `[value]`. Rich labels can supply `[contentTemplate]` and
  readonly `[content]`: `value` then identifies the phase, and the template's
  `$implicit` receives that phase's content snapshot. Content updates within a
  phase preserve child identity (for example a rolling Ticker); changing phase
  retains the outgoing snapshot during its blur/slide exit. Session caps use
  this for “N older” ↔ “Show fewer”, with the native action and focus retained.
- Keyed Angular `@for` blocks with entry/exit classes implement the design's
  MotionList vocabulary. `Message.isNew` explicitly opts a new message into
  entry motion; opening existing history never does.
- Observers, subscriptions, timers, scheduled frames and WAAPI animations are
  disposed by their owning component/directive. Reduced motion disables movement
  and loops. Motion never gates user input.
- Running status indicators rotate their HTML host so Chromium can composite
  them without repeated SVG layout. A separate inner surface owns one-shot
  status changes; changing reduced motion cancels those effects immediately.
  Keep continuous motion off inner SVG paths, and avoid blanket layer hints
  across repository-sized lists.
- Menus/popovers use CDK overlay/focus facilities. Native buttons retain native
  disabled, keyboard and form semantics. The button primitive is used as
  `<button exButton variant="primary">…</button>`; icon actions require a label.

Use the shared [dropdown components](src/app/ui/dropdown/README.md) for ordinary
single-choice controls and action menus. Task stages, workspace selection,
project menus, Git actions and settings choices share these primitives. Keep
searchable pickers and forms as specialized dialogs.

## Design sources and deliberate adapter boundaries

The [brand book](../../docs/design-system/project/README.md), tokens and component
specifications were imported verbatim from the supplied standalone ZIP.
`docs/design-system/project/tokens.css` is authoritative and is copied verbatim
by the desktop commands. The two licensed fonts are bundled locally; the
reference's runtime Google Fonts import is not shipped.

The current component families include project creation/settings, repository
tags, sub-task navigation, git-helper jobs and machine onboarding. Machine Home
owns first run and card preparation; AddMachine owns SSH/pair dialogs. RunChoice
and its old flow have been removed. Full-window GettingReady is reserved for
updates to a machine already open in a window. Features the designer marked
as not designed (Code/Actions content, global Settings, command palette, split diff,
multi-line review comments) were not invented. The existing desktop CSP is
preserved: HTML reply cards emit an Open in Browser intent rather than creating
an untrusted frame; external media needs a confined platform resolver. Mermaid
fences stay readable code until a trusted diagram adapter is supplied.

Large change lists use CDK virtual scrolling. Reviews page files and lines and
request content lazily rather than computing unbounded diffs in the UI thread.
The owner is responsible for incremental repository data, bounded history
windows and cancelling asynchronous work after navigation.

Toast defaults still dismiss after an action. For asynchronous Undo, use
`dismissOnAction=false`, bind `busy` to disable duplicate actions, and remove the
toast after confirmed success. The session archive owner retains a dismissible
notification (`duration=0`) so a failed/uncertain restore remains reviewable.

The `/agent-picker` preview compares the supplied AgentPicker layout and usage
variants. `Switch` accepts `size="sm"` for its reference 28×16 agent-setting form;
its default size remains unchanged. Both sizes expose native switch semantics,
visible focus and reduced-motion behavior.
