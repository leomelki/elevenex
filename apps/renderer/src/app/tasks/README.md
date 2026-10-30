# Task and navigation components

Import public components and readonly view models from `./tasks`. Components use signal inputs, typed intent outputs and OnPush change detection. This family has no platform calls, git operations, clipboard access, repository scans or application store. The feature that supplies the inputs owns those operations and feeds the result back through inputs.

`projects/` owns project identity and scope navigation. `outline/` owns the task/sub-task/session outline (sub-tasks retain one visual indent at any branch depth). `lifecycle/` owns task context, stages, links and closing. `branches/` owns the new-task form and branch/workspace selection. `navigation/` owns task side views and git actions. `task.models.ts` contains renderer view contracts; it does not replace privileged IPC contracts in `packages/shared`.

| Component | Main inputs | Intent outputs |
| --- | --- | --- |
| `ProjectMark` | `name`, `logo`, `initials`, `emoji`, `icon`, `hue`, `size`, `decorative` | None; precedence is logo, emoji, icon, letters; broken logos use the supplied face |
| `ProjectRail` | `projects`, `all`, `activeId` | `selectProject(id)`, `addProject(tile)`, `reorderProjects(ids)` |
| `StatusSummary` | `counts`, `active` | `selectStatus(status or null)`; a second click clears the filter |
| `StageGlyph` | `stage`, `size` | None |
| `TaskStage` | `stage` | `stageChange(stage)` |
| `LinkChip` | `kind`, `label`, `state`, `href`, `compact` | `activated()` |
| `TaskHeader` | `title`, `repo`, `parent`, `stage`, `branch`, `links`, `meta`, `project`, `git`, `closeSuggested`, `panelOpen`, `branchCopied` | `stageChange`, `closeRequested`, `panelToggle`, `branchRename`, `branchCopy`, `linkRequested`, `linkActivated(link)`, `gitAction`, `changesRequested`, `parentRequested(TaskParentContext)` |
| `CloseTask` | `title`, `sessions`, `running`, `unpushed`, `uncommitted`, `ticket` | `confirmed({push, moveTicket})`, `cancelled()` |
| `RepoTag` | `repo: Repo or string`, `size` | None; hover exposes name/path |
| `SubtaskGlyph` | `depth` | None; a fixed-width stair mark capped at three levels |
| `TaskLine` | `task: TaskContext`, `branchCopied` | `renameRequested()`, `branchRename(name)`, `branchCopy(name)` |
| `BranchPicker` | `query`, `branches` or precomputed `items`, `allowCreate`, `base`, `highlighted`, `label`, `listId` | `pick(row)` |
| `BranchChip` | `name`, `base`, `compact`, `copied` | `renameRequested(name)`, `copyRequested(name)` |
| `WorkspacePicker` | `value`, `items` | `valueChange(name or 'auto')`, `newWorkspace()`, `manageWorkspaces()` |
| `NewTask` | `project`, optional `projectMenu`, `active`, `repos`, initial `repo`, pure `branchesFor(repoId)`, `branches`, `bases`, `base`, `branchPrefix`, initial `title`, initial `step`, initial `branchQuery`, `baseQuery`, `hi`, `workspace`, `workspaces`, `links`, `autoFocus` | `create(CreatedTask)`, `plan(PlannedTask)`, `cancelled()`, `linkRequested()`, `projectRequested()`, `addRepository()`, `workspaceRequested('new' or 'manage')` |
| `SessionRow` | `session`, `selected`, `muted` (boundary title only), `depth`, optional `context` for a two-line attention shortcut, `allowArchive` (default false), `archived`, `allowRestore` | `activated(sessionId)`, `archiveRequested(TaskSession)`, `restoreRequested(TaskSession)` |
| `ArchivedSessions` | `archive: TaskSessionArchive`, `selected`, `disabled` | `requested(latest or earlier)`, `selectSession(sessionId)`, `restoreRequested(TaskSession)` |
| `TaskGroup` | `task`, `selected`, optional `reveal: {sessionId}` request, `filter`, `showProject`, `showLink`, `allowAdd`, `allowAddSubtask`, `allowArchive`, `archiveDisabled`, `cap` (5; 0 uncapped), `capStep` (5), `sessionDisclosure` (model) | `archiveRequested(TaskSession)`, `restoreRequested(TaskSession)`, `archivedSessionsRequested(latest or earlier)`, `selectSession(sessionId)`, `addSession(taskId)`, `addSubtaskSession(subtaskId)` |
| `TaskList` | `tasks`, `selected`, `filter`, `showProjects`, `sessionCap` (5), `allowArchive` (false), `sessionDisclosures` (model) | `archiveRequested({taskId, session})`, `restoreRequested({taskId, session})`, `archivedSessionsRequested({taskId, page})`, `selectSession({taskId, sessionId})`, `addSession(taskId)`, `addSubtaskSession({taskId, subtaskId})`, `closedRequested()` |
| `PanelTabs` | `tabs`, `active`, `labelled`, `label` | `selectTab(id)` |
| `GitBar` | `files`, `add`, `del`, `ahead`, `busy`, `busyLabel`, `compact`, `mergeInto`, `job` | `action(GitAction)`, `changesRequested()`, `jobSessionRequested(sessionId)`, `jobCancelled(jobId)` |

The `Component` suffix and `ex-` selector prefix apply to the names above. `branchItems`, `branchFromTitle`, `validBranchName` and `matchesSessionFilter` are pure exported operations, independently testable without rendering.

## Ownership and interaction

- NewTask accepts an owner-supplied `projectMenu` template composed with the shared dropdown menu/radio controls. It opens directly from the header button without changing card layout; without a template the button still emits `projectRequested`. Bind `active=false` when a retained dialog closes or becomes busy to dispose its portaled menu. The connected-workspace preview demonstrates this composition.
- Use stable task, session, project and tab IDs. TaskList renders a single keyed outline in supplied order, independent of stage; stage changes preserve task positions and local folds. Tasks default to expanded. A compact Needs you area offers three contextual shortcuts for attention/failed sessions (including unmerged sub-tasks), with a reveal control for the rest. Closed tasks never contribute. Shortcuts emit the same selection intent as canonical sessions; a new selection opens its containing task and sub-task. TaskList also supplies a fresh `reveal` request on every shortcut activation so reselecting the current session reopens its manually folded task/sub-task. Filtering hides shortcuts and keeps hidden task components mounted and inert. Sessions keep their original order; a question changes its signal rather than moving its row. Completed and stopped sessions remain normal rows in the supplied order, with the same earlier-session cap as other sessions. Activity status never archives or groups a session; the owner excludes explicitly archived sessions from the normal task list.
- Task and session controls expose their full titles through the shared hover/focus tooltip. Attention, failure and selected rows retain their semantic surfaces with distinct hover feedback. Supply `TaskOutline.repo` only when the project's repository context needs disambiguation; single-repository projects omit it. The containing feature owns the task-list scroll region so its header and pagination remain available.
- Task headers share one full-row surface on hover or focus within; the New session icon retains its stronger local hover and focus ring. Hovering a session does not highlight its parent task header.
- Feed a bounded task/session window into the outline; request pagination in the owning feature. BranchPicker shows at most seven results. It matches every query word, promotes exact/default matches and retains the caller's recency order among equal matches. Held branches remain visible but cannot emit a pick. From excludes held branches. Input validation improves the form; privileged git handlers must validate again.
- NewTask keeps its draft locally. Name → Branch → From uses Enter, arrows change the highlighted branch, Shift Tab returns to a prior step, Cmd/Ctrl Enter creates immediately, Alt Enter saves Planned and Escape emits cancellation. Existing branches also advance to From, which explains that history is kept and focuses Create task. With several `repos`, Repository is step 2; the initial `repo` is preselected, and the supplied `branchesFor` lookup and repository `base` drive Branch/From. A single repository retains three steps. The footer action says Next until From, then Create task; it follows the same highlighted answer as Enter. Initial form inputs are read once: destroy/recreate the form to open another draft. The chosen branch and base are rechecked against current supplied data before creation. Workspace selection is included in both create/plan payloads; multi-repository drafts include the repository ID. The Add repository intent lets the owner open project settings. The renderer never scans repositories.
- Sub-tasks use stable IDs and optional parent IDs. Their supplied hierarchy is ordered once and rendered at one indent; malformed/cyclic ancestry is tolerated. Selection lights the current sub-task and its ancestry, while hover/focus temporarily lights its own path and gives a 500ms path hint. After four open sub-tasks the list keeps three and the selected one, with a reveal count for the rest. Merged branches have their own merged fold with their diff; completed sessions stay in the normal list. Root task signals and status filtering include nonmerged sub-task sessions. Each sub-task owns its folds; TaskGroup owns paths and the hint timer.
- `FittedHighlightDirective` owns one measured picker selection surface. Selection changes glide with `dur-glide`/`ease-glide`; resized lists fit the selected row immediately. The observer, reduced-motion listener and interrupted animation are released on destruction. `Ticker` leaves initial history still and rolls changed live counts using the same motion tokens.
- The owner handles branch rename/copy requests and supplies `copied` or `branchCopied` after a successful copy. LinkChip emits activation so the owner can validate the URL and use the existing platform boundary. It never navigates an untrusted renderer URL directly.
- CDK menus supply keyboard navigation and focus restoration for stage/workspace/git menus. CloseTask owns its modal backdrop, CDK focus trap and cancellation. Render it conditionally; remove it when an output resolves the dialog. If no running sessions or unpushed work would be affected, the feature may close immediately and offer Undo. NewTask is a reusable card; a feature that presents it modally owns its dialog boundary.
- PanelTabs implements automatic activation with arrows/Home/End and roving focus. Desktop side views use Terminal, Actions, Changes, Code, Browser order. Provide `panelId` on a tab to connect it to the owning feature's tabpanel. Global project shortcuts and new-task shortcuts belong to that feature. Project reorder supports drag/drop and Option Shift Up/Down while a tile is focused; the owner applies the requested ID order.
- GitBar keeps a single primary native button across commit/push/busy states. Busy disables its git actions, leaving the rest of the task usable. Combinations emit explicit intents so no component assembles a shell command. The feature-local `navigation/git-bar-motion.ts` owns the measured action/stat slots, outgoing ink, interruption and cleanup; the component retains closing content and owns the current Git intent. Both buttons remain mounted, hidden slots become inert immediately, and reduced motion settles the latest state without waiting.
- With `mergeInto`, committed sub-tasks offer Merge into the parent's short branch name, with squash/merge-commit/rebase/push intents in the menu. `job` supplies a stable ID and keyed steps, optional helper-session IDs/titles, label, waiting state and note. The primary action opens the steps or requests the waiting helper; Cancel emits the job ID. The steps popover retains its exit while becoming inert, releases its focus trap immediately, and restores its trigger. Progress updates retain an open menu; replacing the job resets its local menu state. TaskHeader forwards `gitJobSessionRequested` and `gitJobCancelled`. `/git-jobs` exercises these states and `JobBrief` without git or agent operations.

The isolated showcase is `apps/renderer/preview/tasks-demo.component.*`. Its sample projects, tasks and handlers stay outside the production renderer source graph. Unit tests cover branch validation/filtering, the keyboard creation flow, held branches, task identity across stage/filter changes, finished folds, tab navigation and emitted intents.

## Production workspace adapters

The connected [workspace feature](../workspace/README.md) supplies bounded backend
windows to these components. `TaskOutline.moreSessions` enables the Next sessions
intent (`TaskGroup` and `TaskList.moreSessionsRequested(taskId)`); advancing a
window belongs to the owner. `TaskOutline.canAddSession=false` suppresses creation
while a workspace is preparing. An empty task header emits
`emptyTaskRequested(taskId)` alongside its local disclosure, so the owner can
show task preparation/recovery. `TaskList.disabled` disables session addition
while an owner mutation is running.

`NewTask.branchQueryRequested` emits `{repoId, query, kind:'branch'|'base'}` as the
active picker changes. Existing branches do not request unused base options on
From, so Create task stays enabled and retains keyboard focus. Supply separately bounded results through `branchesFor`
and `basesFor`; `branchesLoading` reports owner work. Default local filtering
continues to work without these optional inputs. `canLink` and
`canManageWorkspaces` disable unsupported integrations while preserving the
designed form. `WorkspacePicker.canManage` controls its new/manage commands.

`TaskHeader.closed` hides stage/close controls for archived history.
`TaskHeader.disabled`, `canRenameBranch`, `canLink`, `gitAllowedActions` and
`gitQuietLabel` let a production adapter expose only supported actions.
`BranchChip.canRename` disables rename while keeping copy available.
`TaskStage.disabled` blocks stage edits. `GitBar.allowedActions` filters its
secondary menu; `quietLabel` permits an actual behind-upstream status.
Defaults preserve existing preview consumers. `CloseTask` accepts real
`terminals`, `actions`, `busy` and `error` inputs in addition to session and
unpushed counts; busy confirmation controls reject duplicate submissions.

`apps/renderer/preview/task-update-demo.component.*` exercises sub-task depth/overflow/merging, parent context, automatic git-helper sessions and new-task repository/skip/disabled states.

`apps/renderer/preview/git-motion-demo.component.*` provides the full Git sequence, count changes and rapid interruption controls. The reusable `scripts/desktop-capture/scenarios/git-motion.mjs` probes real animation frames in both themes and compact modes, checks width interpolation and endpoint continuity, and verifies that the task context and right edge stay fixed. Long intervals between sampled frames are reported separately from animation discontinuities.

## Updated task preview fixtures

The **Task changes** preview section renders `TaskUpdateDemoComponent`. The lifecycle controls (`work`, `deep`, `deeper`, `ready`, `merged`, `overflow`) replace supplied sub-task data while preserving keyed identities. Deep selection is `s22`; overflow selection is `s24`, beyond the initial three rows. Hover/focus a sub-task for its 500ms path hint, select a session to change the lit ancestry, use its plus to emit the sub-task ID, and expand the finished count to reveal merged diffs. The sample header emits its supplied parent context and git action.

The draft controls recreate the card by a version key. **Several repositories** supplies `repos`, initial `repo` and a pure `branchesFor` lookup; **Existing branch** begins on Branch with an exact existing match; **Empty / disabled** starts without a title. The footer's Next follows the same answer as Enter. Existing branch → From moves focus to Create task. Every completion is displayed as an intent below the card. None of these fixtures enter the production app's import graph.

`ProjectRail.addProject` returns the actual + button. Pass it as `ModalLayer.from`
when opening NewProject. On successful Create, clear `from` while closing, append
the supplied project and set its active ID. Existing tiles glide down; later
additions spring in after a short delay with one ring in the project hue. Initial
history stays still, and the first project retains its separate jumpHome owner.
The rail owns and cleans up insertion animations and handles reduced motion.
Workbench forwards the same element through `projectAdded`. `/projects` demonstrates
first-project flight, later creation, controlled selection and cancellation.

## Commit panel and task-screen update (2026-10-27)

`TaskHeader` always shows the quiet **Close task** action for an open task.
`closeSuggested` only changes its color; the button keeps its identity and size.
The owner checks authoritative close counts: a clean, idle task closes directly
with Toast/Undo, while running, uncommitted or unpushed work opens `CloseTask`.
`CloseTask.uncommitted` explains why a dirty workspace stays on disk.

Task and sub-task header + buttons stay visible whenever adding a session is
allowed, regardless of selection, hover or focus. This is an intentional product
override of the supplied design's hover-only buttons on other tasks.
The task header + has a **New session in this task** tooltip on hover and keyboard
focus. Populated tasks have no trailing creation row, so changing selection keeps
the outline height stable. Empty tasks without sub-tasks or more session pages
show a labeled **+ New session** action, independent of selection; it uses the
existing retained outline/Fold ownership, hides while filtering or creation is
unavailable, and emits the same `addSession(taskId)` intent. The connected
workspace owns ⌥⌘N (Ctrl Alt N on other platforms); ⌘N still creates a task.

`CommitPanelComponent` is exported with `CommitFile`, `CommitIntent`,
`CommitSelection`, `CommitFileWindow` and `CommitFileProvider`. Project it into
GitBar or TaskHeader using the `gitPanel` attribute:

```html
<ex-task-header [title]="title" [git]="git" (gitAction)="gitAction($event)">
  <ex-commit-panel gitPanel [open]="commitOpen()" [files]="files"
    [running]="runningNames" [push]="pushAfter()"
    (pushChange)="pushAfter.set($event)" (closeRequested)="commitOpen.set(false)"
    (commitRequested)="commit($event)" />
</ex-task-header>
```

The owner toggles `open` on Commit and closes it on submission. An empty message
means generate the message after submission. Supply `GitState.busyLabel` (or
`GitBar.busyLabel`) with `busy='commit'` for **Writing the message…**. The same
primary button carries on through committing, Push, or remaining changes.

For supplied-data previews, `files` and `running` are readonly inputs. For large
repositories, supply `fileProvider(query, signal)` instead. It returns at most
100 rows, the next cursor, complete match/selection counts, a snapshot revision,
and bounded running-session names. Filtering, staged-only mode, secret defaults
and explicit exceptions apply to the whole repository on the server. The panel
retains one page; **Next files** replaces it inside the same six-row scroll area.
The owner must honor abort/stale scope checks. Paged owners commit the explicit
`selection` and `revision`; `intent.files` is complete only for supplied-data use.
Exceptions are limited to 1,000 paths and 64 KiB per list by the platform boundary.
The panel opens immediately while the provider checks files. The message stays
editable during loading; submission remains disabled until the check succeeds.

The panel owns draft/filter/disclosures, focus trapping, Escape/outside dismissal,
resize observation and its retained exit. Its content stays frozen while closing.
`MorphFromMotion` shares ModalLayer's launch geometry with `noFace` and `fadeIn`:
560ms opening, 500ms closing, a fade for reduced motion, no cloned Commit button.
The connected preview demonstrates the production composition. Run
`task-screen-update.mjs` through the desktop capture tool for both themes,
keyboard/focus, filtering, secret opt-in, staged-only, motion and narrow layouts.

For a remote `fileProvider`, the initial window resolves before measuring entry,
so summary/notices cannot change the morph's target mid-flight. The opener stays
available for a second click/Escape and announces busy while that read is pending.
Subsequent queries keep the panel mounted, disable confirmation and show Checking
files in its footer. Reopening during a retained exit preserves the current draft;
a fresh open after the exit resets it.

## Session archiving and working window

Opt into archive actions with `allowArchive` and handle `archiveRequested` in the
owner. The action is absent by default. Running rows require a second activation
in the expanding Stop and archive button; Escape, blur and outside pointer input
cancel it. Pointer leave retains confirmation. Nonrunning rows emit immediately.
Sub-task rows forward the same intent. Consumers resolve the session's owning task
when integrating a hierarchy. The connected workspace validates task/session
ownership and current activity again in main/backend, retains history and edits,
then removes the row and offers Undo. Restoring a stopped turn never restarts it.

`TaskGroup.cap` / `TaskList.sessionCap` show the newest five normal sessions in
supplied chronological order, plus attention/failed, selected and fresh rows.
Each Older click reveals at most `capStep` more hidden sessions. Show fewer
resets that disclosure; filters and cap 0 show every supplied match.
The disclosure snapshots the remaining hidden IDs, so adding, removing or
refreshing sessions never hides a previously revealed survivor. Showing all
also keeps subsequent new sessions visible. `TaskGroup.sessionDisclosure` is an
optional model of `TaskSessionDisclosure | null`; null uses the default cap.
`TaskList.sessionDisclosures` is a model of a readonly task-ID map. It retains at
most 200 task disclosures, evicting the least recently changed entry. Bind it to
an owner that outlives project views when the list itself can be recreated, e.g.
`[(sessionDisclosures)]="store.sessionDisclosures"`. The workspace owns this
view-state map for one backend scope, preserving it between All projects and a
specific project and clearing it when that scope changes. Standalone groups
retain their own disclosure until their task identity or cap no longer matches.
Hidden sessions keep their activity and contribute to task counts; their DOM is
created on reveal. A quiet 26px “› N older” button replaces the ghost pill, with
an accurate next-batch accessible label and `aria-expanded`. Partial reveals
show a separate Show fewer button; fully revealed lists use “⌄ Show fewer”.
Only the first title below a remaining cap is muted with `ink-muted`; selected,
attention/failed and fresh rows retain their normal color. Titles ease color.

The internal `WorkingSessionsComponent` owns placement and disclosure;
`SessionBatchComponent` owns one pixel-height scroll and its cleanup. Revealed
batches snapshot identities, so selecting or changing a revealed row's status
keeps its component and position. Archive gaps draw from the next older rows
across batches, preserving chronology. New arrivals stay in the main list.
Show fewer retains closing batches until they settle and keeps the selected row
in the main list. Rapid reveals reverse from the painted height. A batch pins
its rows to the bottom and masks its top 18px only while moving. Open batches
release height, mask and overflow after settling; closed batches stay clipped
until removal so retained rows cannot flash outside their zero-height box.
The duration is `clamp(440, 320 + 1.3 × pixels,
760)` on `cubic-bezier(0.33, 0, 0.15, 1)`; closing batches share their total travel
so the list closes as one surface. Rows inside a batch retain the existing
ListPresence/Fold archive behavior. Reduced motion is instant, including when
its preference changes during a scroll. No per-row unroll delays remain.

The cap works within the owner's bounded page, independently of backend paging.
`moreSessions` and `sessionsDirection` expose older/next page requests rather than
fetching unbounded history. Production opens a newest-first 20-session page;
older pages replace that window. Project settings → Tasks stores the device-local
user cap (5, 10, 20 or all loaded sessions), shared across project views/windows.
The Tasks preview includes A busy task; `/connected-workspace` exercises the full
backend-backed owner using an isolated fixture.

Supply `TaskOutline.archive` to add the collapsible Archived section. Its
`TaskSessionArchive` contains a separate bounded `sessions` window plus `loaded`,
`loading`, `error`, `more` and `earlier` flags. Archived sessions never enter the
normal session array, activity counts, attention shortcuts or status filters.
The section loads on first open through `archivedSessionsRequested`; the owner
supplies replacement pages and handles restore/selection intents. A selected
archived conversation reveals its disclosure when the selection changes; manual
collapse remains available and survives history refreshes. Closed folds remain inert, and
removed history rows retain their exit before disposal. `archiveDisabled`
disables the TaskGroup archive controls during mutations; TaskList forwards its
`disabled` input. `SessionRow.archived` uses the archive glyph and suppresses
archive actions; `allowRestore` exposes the separate restore intent.
