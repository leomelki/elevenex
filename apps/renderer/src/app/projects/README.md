# Project components

Import from `app/projects`. The owner supplies project/repository data and handles
all intents. These components never enumerate directories, clone repositories,
start agents, write settings, archive or delete projects.

`NewProject.disabled` prevents interaction and folder reads while preserving the
draft. It is independent of `busy`, which reports an actual creation operation.

`NewProjectComponent` (`ex-new-project`) exposes `machine`, `machineIcon`,
`listFolders`, `autoFocus`, `active`, `cancelable`, `busy`, `disabled`, `launching` and initial `draft`
inputs. A draft contains `name`, optional `repos`, `step` (`repos`, `name`, `look`),
`query`, `listOpen`, `look`, `emoji`, `icon` and `hue`. Draft values initialize
unfinished local state once; recreate the component for another draft. `create`
emits `{ project: NewProjectResult, card: HTMLElement }`; `cancelled` emits Escape
when `cancelable` is true. Set `busy` while accepting a creation request.
Set `active=false` as soon as exit begins: the card stays rendered and keeps its
appearance, becomes inert, rejects intents/focus work, aborts folder requests and
closes its popup. Keep it mounted until the owning presence layer finishes exit.

Repositories are supplied folder by folder through
`FolderProvider(query, signal): readonly FolderEntry[] | Promise<readonly FolderEntry[]>`.
The signal aborts when the query/provider changes, the step closes, the control
becomes disabled or the component is destroyed. Late replies and errors from
aborted requests are ignored. Duplicate paths are removed and the result window
is bounded to 50 suggestions. `dir` with no `git`/`clone` drills into that folder;
a plain selectable folder emits an intent for the future owner to initialize git.
`clone` describes the URL and destination intent; it performs no network work.

`FolderSuggestionsComponent` is the reusable combobox: `query` is a model;
`listFolders`, `machine`, `addedPaths`, `active`, `disabled`, `listOpen` and
`autoFocus` are inputs; `selected` emits a folder and `continued` emits Enter on
an empty field. The CDK overlay retains input focus, publishes the active option,
supports Up/Down, Enter and Tab completion and leaves no popup on a closed step.
Its internal `FolderOverlayPosition` owns the popup's resize observer, bounded
position frames and finite ancestor-animation listeners. The component creates
it on attachment and disposes it on detachment/destruction; folder data and
keyboard state stay in the component.

`ProjectAppearanceComponent` uses `appearance: ProjectAppearance` and
`appearanceChange`. `disabled` freezes native controls and rejects patches during
owner work. `showFace` controls its 52px face; `faceHook` adds an optional
`data-np` anchor. Letters derive from the name, the hue derives from its hash until
chosen, and the supplied emoji/icon choices match the reference. The look selector
and hue radios support arrow keys and a single tab stop for each group.

`ProjectMenuComponent` takes `project`, `repoCount`, `machine`, `closed` and
`disabled`. Put it inside an owning `[cdkMenuTriggerFor]` template so CDK owns its
window-level overlay, arrow keys/typeahead, Escape and focus restoration.
`action` emits `settings | add-repository | closed-tasks | archive | delete`.
Named outputs are also available: `settingsRequested`, `addRepositoryRequested`,
`closedTasksRequested`, `archiveRequested`, `deleteRequested`.

The repository settings' Start from control reuses task creation's branch rows
and search matching. It searches every supplied `ProjectRepository.branches`
entry while rendering at most seven matches. The owner handles the emitted
`{base}` patch. Closing the sheet or repository also closes the picker; its CDK
overlay owns search focus, Escape dismissal and focus restoration.

`projectFace(appearance)` returns `ProjectMark` props. `jumpHome(root, from, to,
options)` reproduces the single bell-shaped launch arc, growth and height-dependent
shadow, hides the destination until landing, and returns an owned `Animation`.
Call its `cancel()` on interruption/destruction: copies are removed and the
destination is restored immediately. `settleMark(root, mark, hue)` returns a
disposer for the squash/spring and ring. Reduced motion places the mark directly.
The owner sets `launching=true` and `active=false` while copies fly and dissolves
the card, unveils its app and opens New task together. It hands focus to New
task's name after render so motion never gates typing. Card anchors are `[data-np="face"]` (with an
`ex-project-mark`) and `[data-np="name"]`. The isolated `/projects` preview shows
first-run, modal, launch/interruption, supplied folder states and menu composition.

First-run composition keeps the app behind the card inert and receded without a
cancel destination. Later creation composes the same card inside `ModalLayer` with
`from` set to the + tile emitted by `ProjectRail.addProject`,
`cancelable=true`, `autoFocus=false`, a labelled dialog and `closeRequested`
handling. The layer then captures the opener before focusing the first field;
delegating initial focus to it keeps a single focus owner. ModalLayer also retains
the actual pre-portal opener when projected content autofocuses early. Platform
integration and opening the project/New task remain the owning feature's work.
The preview keeps the last modal card projected through the layer's exit and
binds its `active` to the owner's open state. `openModal()` increments an explicit
draft version on the next open, rather than destroying the outgoing card early.

Native parity checks used the real `/projects` renderer and the supplied live
NewProject/ProjectMenu references in both themes. Settled initial and Look cards
measure 540×275 and 540×383; the project menu measures 268×238. Captures cover
folder/name/look steps, nested overlay composition, Escape/opener restoration,
launch frames at 0/300/600/940ms, landing into New task, interrupted cleanup and
reduced motion. The menu regression uses trusted End/Up/Enter and verifies the
archive intent. Reports `run-brMRSJ`, `run-kbh8cy` and `run-NgEww3` under
`artifacts/desktop-capture` are verified; reference reports are `run-ToEHmB` and
`run-DjhfG8`. The reference's initial EaseSwap can retain a pre-font width two
pixels wider than its loaded child; the Angular adapter observes loaded text
instead of preserving that stale width.

For later projects, clear the modal's `from` and set `open=false` together on
Create, then add and select the project. The outgoing draft remains inactive
through the plain exit; the rail owns its new tile's pop/ring. Cancellation keeps
`from` so the dialog returns to +. The first project's jumpHome flow is unchanged.
