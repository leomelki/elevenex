# Connected workspace navigation

Saved task setup failures explain workspace quota limits and offer **Create
workspace anyway** only when the backend advertises that recovery. This explicit
choice retries the same task above the limit without changing the configured
limit. Ordinary retry remains available after freeing a workspace. Busy and
uncertain setup writes retain the existing disabled/reconciliation behavior.

`MachineWorkspaceComponent` provides one `WorkspaceStore` for its connected
machine and calls `connect(machine, active || preparing)`. Preparation permits
bounded reads for the selected candidate behind inert Home; interaction remains
controlled by `active`. Returning Home or cancelling preparation releases the
scope as before. The store owns backend-scoped
project/task/session selection, bounded navigation windows, creation drafts and
durable navigation operations. It calls only named methods on the typed preload
bridge. The backend connection service continues to own connection state alone.

The workspace saves its selected project/task/session, Closed view, focus/status
filter, bounded project/task cursors and side-panel tab/open/wider-review state
through `saveEnvironmentContext`. Main stores a separate context per window and
backend (local or saved SSH host) in application data. Returning from Home,
reconnecting or reopening the app reconciles that context before saving again.
Old contexts without layout fields retain the default closed Changes panel.
Unsent input and domain-event cursors in the existing context are preserved.

Restoration has three owners. `WorkspaceResume` handles context persistence and
save coordination. `WorkspaceRestoration` is a read-only coordinator with a narrow
bridge dependency: it reconciles saved identities and returns immutable bounded
project/task/session windows. It has no Angular state, UI callbacks, watchers or
mutation methods. Its caller supplies the scope/navigation lifetime predicate;
each read checks it before dispatch and after completion, including failures.
`WorkspaceStore` applies those windows through the same page hydration used by
ordinary navigation. `WorkspaceSessionArchives` adopts reconciled archive pages
only for its retained scope/tasks and invalidates earlier in-flight replies.
Already reconciled session windows are reused instead of fetched again.

The numeric, exclusive keyset policy lives in `workspace-restoration.ts`, including
the project-window boundary reused after creation. Future protocol ordering or
cursor-format changes belong there rather than in the UI state owner. These
helpers and coordinator remain private to this feature's module boundary; the
family's public component/store API and persisted context format are unchanged.

Restoration uses bounded keyset windows around saved IDs when newer tasks or
sessions have displaced them. Missing resources clear selection; transient read
failures retain the saved state for Refresh. Explicit navigation and scope
changes discard late restoration replies. Archived and closed conversations
remain archived/closed; task setup, commands, prompts and session creation are
never replayed. Panels currently restore their frames and selected tab, not
terminal/browser processes or unsent modal forms. Failed saves appear in the
navigation notice and retry on the next change. Exit dispatches the latest queued
snapshot before releasing the workspace owner.

Compose the exported `WorkspaceProjectRailComponent` in `shellRail`,
`WorkspaceNavigationComponent` in `shellSidebar`, `WorkspaceTaskHeaderComponent`
above the selected session’s empty main region, and `WorkspaceDialogsComponent` beside the
shell. `WorkspaceOnboardingComponent` is the first-project card. It emits
`projectSubmitted(CreateProjectIntent)` before dispatching creation and accepts
`launching`; the machine container owns source retention and the existing
`jumpHome`/`settleMark` flight into the rail. The task header accepts `panelOpen`
and emits `panelToggle`; panel processes are outside this feature.

Later projects open from the rail's supplied plus-button origin through
`dialogFrom`. Cancellation keeps that origin for the return morph. A successful
creation clears the origin, preserves the outgoing draft through the actual
modal exit, then uses `ModalLayer.closed` to request focus on the new project's
visible New task action. The app remains visible; the task form opens only on
request. The focus request is scoped and cancelled by another dialog or navigation; it
does not depend on a guessed animation timeout.
Task name and repository fields mark their initial focus for the modal's CDK
trap; modal forms keep component autofocus disabled. Dialog widths follow the
supplied cards (task 560px, project 540px, delete 460px), and the child owns its
surface. Git drafts submit through native forms, including Enter in the field.

`selected()` returns `{scopeId, taskId, sessionId}` with numeric resource IDs.
`selectedTask()`, `selectedSession()` and `selectedProject()` expose loaded DTOs.
Session activity comes from authoritative backend navigation pages. Persisted
session `active` is not an indication that an agent is running.

## Bounds and invalidation

- Project pages contain at most 50 projects; task pages contain at most 20 tasks.
  Each task initially loads at most 20 sessions, with four concurrent reads.
  Advancing a page replaces its window. Controls return to the first page;
  a selected older session is retained during refresh without exceeding 20.
- The initial `workspaceRevision` probe verifies protocol version 1 before
  dispatching a workspace snapshot. Unsupported older runtimes receive an update
  message. `WorkspaceNavigationObserver` owns a five-second revision probe; only
  a changed revision reloads the visible resource windows. Probes pause while
  hidden, busy or preparing a task, and resume on visibility/focus. The store
  disposes the observer on scope replacement and destruction.
- Status summary counts describe visible sessions rather than unbounded global
  totals. Focus mode mutes the other loaded project tiles. Task list identity
  and folds remain owned by the reusable outline components.
- The sidebar scrolls its bounded task window independently of the project header,
  status summary and footer. Refresh lives in the footer to preserve project-title
  space. Closed history omits the active-session filters. Project navigation
  removes only tasks outside the destination view before loading its replacement.
  All matching tasks and their sessions stay mounted throughout loading and on
  read failure, preserving row identity and local folds independently of selection.
  A matching selected task also keeps its main view mounted. Closed history
  clears the previous view before loading its replacement.
- Optional `WorkspaceTask.projectRepositoryCount` arrives with task summaries;
  the backend counts through the project/path index without loading repository
  lists or issuing extra renderer requests. Exactly one repository suppresses
  its tag in both the outline and selected header. Older runtimes that omit the
  count keep their existing repository hint.
- New-task branch search uses `branchQueryRequested` and separate branch/base
  windows. The owner debounces requests for 160ms, asks the backend for at most
  50 matches, and rejects stale replies. Actual default base and held-task
  metadata come from the backend; the current checkout is not the default base.
- `WorkspaceTaskGitService`, provided by the selected header, owns one focused
  five-second git-status probe, visibility/focus listeners and mutation epochs.
  Unknown git state is not presented as “Up to date”. Commit and branch rename
  require explicit drafts; push is non-force and sync uses the backend's safe
  fast-forward behavior. PR and merge commands are excluded from this slice.

## Creation, failures and cleanup

Task creation returns a preparing task. The store keeps `pendingTask()` and
polls that task alone with a 400ms to five-second backoff for at most five
minutes. The backend creates the initial session; the renderer never creates a
duplicate initial conversation. `preparationPaused()` offers reconciliation
after a timeout/read failure, and `retryPreparation()` explicitly retries failed
setup. Project/session navigation, Closed, scope replacement and destruction
stop polling and reject late responses. Empty task rows reopen this preparation
context, or create a session once the workspace is ready.

Failed task replies may carry optional `setupIssue` display data. The backend
maps persisted setup errors to bounded messages and supported choices; raw Git
output, setup configuration and credentials stay private. An existing branch
checked out elsewhere offers Use existing workspace (explicit consent including
its local edits) or Use committed revision (a separate, pinned workspace). The
sidebar avoids repeating the failure while the main setup surface owns it.

`retryPreparation(recovery?)` retries the saved task ID, never creates another
task, and rejects late replies after navigation. The existing numeric
`workspaceRetryTask(scope, id)` call retains its default; optional `use-existing`
and `snapshot` choices are validated against the durable failed task before
calling the existing task lifecycle. Busy/owned/locked workspace checks are
unchanged. An uncertain recovery blocks replay until a focused task refresh
reconciles its durable state; a failed refresh leaves replay blocked.

Mutations capture the scope that supplied their IDs. Late same-scope selection
replies cannot select a task in another project. Definite backend rejections keep
their safe message. Uncertain writes block another mutation until a durable
refresh; task creation retains its request ID for the current draft. No mutation,
prompt or git command is replayed after reconnect. Closing first requests real
session/process/unpushed counts; Push and close must finish the push before the
task is closed. Archive has Undo; deletion uses the shared confirmation.
Confirmed deletion closes the project's open tasks and stops its sessions before
removing history. A cleanup failure keeps the project for an explicit retry.
Progress and cleanup errors retain keyboard focus inside the confirmation.

New project lists one directory level through an abortable provider, debouncing
superseded queries before IPC dispatch. `folderProvider()` captures the current
backend scope and rotates identity on replacement, clearing the picker's bounded
cache. Folder errors remain local to the picker.
Existing repositories show their current branch from bounded Git metadata reads.
A path without a trailing slash selects/completes that folder; a trailing slash
lists only its immediate children. Plain folders can be selected for Git setup.
The picker can also offer an HTTPS /
SSH Git URL and its destination under `~/code`. The store sends explicit,
validated setup intents alongside the legacy-compatible path fields. Setup is
request-owned and bounded to two minutes; the bridge allows a short margin for
the response. The backend never overwrites an existing clone destination.
Plain-folder setup creates an empty root commit to support task workspaces,
leaving the person's files uncommitted. A failed clone removes only its newly
created destination; successfully prepared repositories survive later failures.
The creation card retains its draft and offers explicit durable reconciliation
for an uncertain outcome. Creation opens a bounded project window around the new ID when the first page
is full; its cursor survives background revision refreshes.

The production settings sheet offers persisted project name, appearance,
instructions and repository addition. Unimplemented PR/ticket linking and
workspace-pool management remain disabled. Dialog content stays mounted through
its modal exit; each new draft has a new identity. Timers, listeners, queued
branch queries and selection epochs belong to their scoped owner.

Focused tests cover bounded/focused reconciliation, stale scopes, task setup and
navigation cleanup, uncertain writes, server branch search, revision probing,
git polling cleanup and navigating away/back during a git mutation. The
`/connected-workspace` preview composes the production feature with an isolated
typed fixture; it is not part of the production import graph.

The October 27 task-screen update replaces the commit modal with the anchored
`CommitPanel`. A scope-bound `workspaceCommitPreview` returns 100-file windows,
server-side filtering and complete selection totals; it never supplies an entire
repository to Angular. The advertised `commitPanel` capability gates the new
flow on older engines. Empty messages use the backend's existing agent message
generator. A private index freezes selected changes before generation; excluded
staged entries and edits made later by running sessions remain outside the commit.
`WorkspaceTaskGitService` observes writing/committing/pushing phases only while
its own operation is pending. Timers and replies belong to the selected task/scope.
No write is replayed on reconnect. Refresh status after an uncertain outcome.

Close checks authoritative uncommitted, unpushed and process counts. A clean,
idle task closes directly; other tasks show the existing confirmation. The
workspace retains a scope-bound Toast/Undo operation after either flow. New
session is discoverable on the selected task and through ⌥⌘N.

Session rows expose archive only when the backend advertises `sessionArchive`.
The owner removes a row from the normal list only after confirmed success, selects its next normal
neighbour when necessary, and retains a scoped Toast/Undo. Main validates IDs,
confirmation and response identity; backend checks task ownership/readiness and
live activity before strict process cleanup. Desktop row archives retain
`archivedByTask` so normal task reopen restores them, without changing legacy
standalone archive behavior. Completed and stopped conversations remain normal
sessions in chronological order; only explicit archiving removes a row. Archiving
the selected session selects the next remaining conversation, wrapping to the
first. Undo restores a stopped conversation. Unknown writes require
refresh/reconciliation; neither archive nor restore is replayed.

The session cap is a device-local user preference owned by
`SidebarPreferencesService`, independent of backend/project settings. Settings →
Tasks applies it across projects and synchronizes other windows through storage
events. Session reads opt into newest-first keyset pages returned in chronological
order; omitted ordering retains legacy oldest-first behavior. Each window stays
bounded to 20 sessions with explicit older-page navigation. The cap and attention
exceptions apply to this supplied window; this slice does not enumerate all
historical sessions just to render the sidebar.

Session disclosures belong to the workspace's backend scope, keyed by
task ID, rather than the lifetime of one project-view component. The TaskList
binds its bounded `sessionDisclosures` model to that map. Changing project views,
refreshing resource DTOs, creating sessions and archiving sessions retain the
remaining hidden identities; only Show fewer resets the task's disclosure.
The map retains at most 200 task entries and is released on scope reset, so
unrelated backends cannot inherit disclosures for coincidentally equal IDs.

Backends advertising `sessionArchiveHistory` also expose a collapsible Archived
section for each ready active task. `WorkspaceSessionArchives` owns independent
newest-first 20-session keyset windows, retained only for the current bounded
task page. A bounded one-session probe establishes whether each task has any archives;
empty tasks omit the section. First opening loads the full bounded history page,
and refresh reconciles requested windows without enumerating all archives.
Restoring the last archived conversation removes the section. Empty older pages
reconcile against the newest window before deciding whether any history remains. Main validates the optional lifecycle
filter and rejects replies from the wrong task or lifecycle. Older runtimes keep
their existing behavior and do not receive archive-history reads.

Archived conversations can be selected without restoring them. Restore works
independently of the Undo notification, returns a stopped conversation to the
normal list, selects it and transfers focus once its entry fold becomes active.
Changing an archive page clears a selection that leaves that window. Scope reset,
task removal and disposal discard stale reads and release history state. A
successful mutation invalidates earlier archive reads, waits for their shared
transport request to settle, then reconciles durable history. Failed reads remain
retryable inside the section; interrupted writes retain the existing uncertain
outcome flow rather than being replayed.

Project creation supplies a scope-bound `ProjectNameProvider` to both onboarding
and the later-project dialog. The named `workspaceProjectNameAvailability` bridge
reads `GET /desktop-workspace/projects/name-availability?name=…`, using the exact
database name lookup across active, archived and hidden projects. It does not
enumerate project pages. Pending/failed checks block progression and editing the
name starts a new check; stale scope/cancelled replies are rejected. Creation also checks the name
before repository setup, while the database constraint remains the final guard
against concurrent creates. This check needs a backend exposing the new endpoint;
an unavailable check leaves the draft intact and blocked.
