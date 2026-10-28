# Project components

Import from `app/projects`. The owner supplies project/repository data and handles
all intents. These components never enumerate directories, clone repositories,
start agents, write settings, archive or delete projects.

New project starts its folder query at `~/`; removing the last selected repository
returns to that location. Explicit draft queries are preserved.

`NewProject.disabled` prevents interaction and folder reads while preserving the
draft. It is independent of `busy`, which reports an actual creation operation.

`NewProjectComponent` (`ex-new-project`) exposes `machine`, `machineIcon`,
`listFolders`, `checkName`, `autoFocus`, `active`, `cancelable`, `busy`, `disabled`, `launching` and initial `draft`
inputs. `error` displays an inline failure without dropping the draft;
`recoveryRequired` blocks creation after an uncertain write, `recovering` disables
the explicit Check projects action, and `recoveryRequested` asks the owner to
reconcile durable state. Creation accepts at most 20 repositories and a project
name of at most 100 characters. A draft contains `name`, optional `repos`, `step` (`repos`, `name`, `look`),
`query`, `listOpen`, `look`, `emoji`, `icon` and `hue`. Draft values initialize
unfinished local state once; recreate the component for another draft. `create`
emits `{ project: NewProjectResult, card: HTMLElement }`; `cancelled` emits Escape or the named cancel button
when `cancelable` is true. Set `busy` while accepting a creation request.
Set `active=false` as soon as exit begins: the card stays rendered and keeps its
appearance, becomes inert, rejects intents/focus work, aborts folder requests and
closes its popup. Keep it mounted until the owning presence layer finishes exit.

Supply `checkName: ProjectNameProvider(name, signal)` in connected creation flows.
It returns whether the trimmed name is available across all projects, including
archived/hidden projects, using the backend's exact name matching. Checks debounce
typing and abort on name/provider changes, inactivity, disabling or destruction;
late replies are ignored. Pending, taken and failed checks block Next from Name,
the Look heading and every creation shortcut. A compact status line below the
field reserves its height while availability changes. Editing the name checks it
again automatically, including after a failed check; there is no retry control.
Provider identity must change with backend scope. Omission keeps isolated supplied
drafts usable without a platform integration.

Repositories are supplied folder by folder through
`FolderProvider(query, signal): readonly FolderEntry[] | Promise<readonly FolderEntry[]>`.
The signal aborts when the query/provider changes, the step closes, the control
becomes disabled or the component is destroyed. Late replies and errors from
aborted requests are ignored. Duplicate paths are removed and the result window
is bounded to 50 suggestions. Folder selection never descends automatically: Enter selects the highlighted
folder, including plain folders. Tab completes its path with a trailing `/`
to browse its children, including when the directory name is already complete. Tab during a pending lookup
waits for that query's results; stale replies cannot complete newer input. Git
URLs keep their URL on Tab and emit their clone intent only on selection. A plain
selectable folder emits an intent for the integrating owner to initialize Git.
`clone` describes the URL and destination intent; it performs no network work.
A selected non-Git folder produces `NewProjectRepo.initialize=true`. The connected
owner passes these explicit setup intents through the named project operation;
components themselves remain independent of Git and filesystem APIs.

`FolderSuggestionsComponent` is the reusable combobox: `query` is a model;
`listFolders`, `machine`, `addedPaths`, `active`, `disabled`, `listOpen` and
`autoFocus` are inputs; `selected` emits a folder and `continued` emits Enter on
an empty field. `initialFocus` marks the active field for an owning modal's CDK
focus trap without adding another autofocus owner. The CDK overlay retains input focus, publishes the active option,
supports Up/Down, Enter and Tab completion and leaves no popup on a closed step.
Escape dismisses suggestions first; a second Escape reaches the containing
project dialog. Navigation skips already-added paths and keeps the active option
in view. Empty results have visible feedback; failures support Retry or Enter
without changing the query. Enter on appearance controls retains native activation
and never creates a project accidentally.
Its internal `FolderOverlayPosition` owns the popup's resize observer, bounded
position frames and finite ancestor-animation listeners. The component creates
it on attachment and disposes it on detachment/destruction. The component owns
local keyboard state. `FolderSuggestionsSource` owns at most eight
windows of 50 supplied entries, filters only compatible directory windows while
fresh reads run, and clears them on provider replacement, deactivation or teardown.
Supply a new provider identity when the backing machine/backend scope changes.
The connected workspace does this through `WorkspaceStore.folderProvider()`.

Typing preserves keyed rows, the popup and the highlighted path. Loading feedback
waits 150ms; cached matches stay usable, and a new directory shows a bounded
skeleton until its own reply arrives. AutoHeight and FittedHighlight own height
and selection motion. Text selection and the caret stay untouched on replies.
Explicit Tab completion preserves `~/`, adds `/` and moves the caret to the end.
Tab with a selection or a caret in the middle leaves normal focus navigation
available. Pending Tab/Enter is applied once to the current query, and is
cancelled by editing, blur, Escape or navigation keys. Composition suspends reads
and keyboard intents until the IME finishes. Clicking the field reopens dismissed
suggestions without changing the text.

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

The optional `actions` array bounds the supported menu actions; its default
includes every documented action. `DeleteProject.tasks` and `sessions` also
accept `undefined`, which describes all project data without inventing a total
from a paginated navigation window. The connected workspace owns its persisted
settings and operations; see [the feature guide](../workspace/README.md).
The deletion confirmation always warns that running sessions will stop, including
when the owner does not supply a running-session count.

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
the card and unveils its app. The connected workspace shows a prominent New task
button and focuses it once the first-project flight or later modal exit ends;
creation never opens another dialog automatically. Card anchors are `[data-np="face"]` (with an
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
