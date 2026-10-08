# Task workflow product proposal

Status: proposed product specification. Initial scope: one repository per task, with support for several repositories later.

Elevenex should organize coding around the piece of work the user wants to accomplish. A user creates a task, works in its sessions, and finishes it when they are done. Elevenex prepares and manages the checkout behind that flow. The task keeps its identity and history when its checkout is reused.

The ordinary paths are equally direct: choose New task, enter a name, and press Enter to start on a new branch; or choose Existing branch, select a local or remote branch, and press Enter to start there. Branch and environment controls stay available beside their defaults. Finishing removes the task from active navigation and preserves its history.

## Naming and product model

Use **Task** for the user-facing object. It names the user's goal whether that is implementing a feature, fixing a bug, investigating behavior, or reviewing a pull request. No code modification or new branch is required to make something a task. **Project** remains the container for repositories and settings. Use Checklist for project todo items and Agent steps for the provider's internal execution lists, keeping those smaller pieces of work distinguishable from the task that contains the session.

Use these labels consistently: New task, Rename task, Finish task, Finished, and Reopen task. Use Changed files or Review for diff surfaces so they remain distinguishable from the list of tasks. Keep Archive project for the existing project-level action. Finishing one task must not archive its project or other tasks.

| Concept | Meaning | User-facing treatment |
| --- | --- | --- |
| Project | A persistent group of repositories and shared settings | Keep the current concept |
| Repository | The codebase where the work happens | Inferred from the entry point whenever possible |
| Task | A goal with saved sessions and repository context | Primary object in navigation and the working header |
| Branch | The existing or new branch selected as coding context | Visible secondary information and an equally direct entry point |
| Worktree | A physical checkout assigned to the task | Automatic by default; available through environment details |
| Session | A conversation or coding session within the task | Preserve the current capabilities |

The hierarchy remains project → repository → task → sessions. A task starts with one repository and a selected branch or captured revision of that branch. Several sessions can work on that same task. Projects continue to provide shared instructions, notes, checklists, browser settings, and forwarding configuration; this release does not move those features into each task.

A stable task ID owns its history. Its display name, branch reference, and current worktree assignment are separate properties. Neither a path nor a branch name is the task's identity: implementation, investigation, and review can be separate tasks concerning the same branch. Names need not be unique; branch information distinguishes repeated names. Task categories are not a required creation step.

## Creating a task

Put New task on the repository row, in empty states, and in the command menu. Include a Start task action on existing branch search results, which opens the same flow with that branch selected. A keyboard shortcut should invoke the same flow after checking existing shortcut assignments. The current repository is preselected. A repository selector appears only when context does not establish a repository or the user chooses to change it.

Use one compact dialog with two equally visible entry modes, **New branch** and **Existing branch**. New branch is the default for the generic New task entry point; branch search entry points open Existing branch directly. These modes state what will happen to Git instead of conflating the task's name with its branch. Existing branch is never hidden in advanced settings.

```text
New task                                        elevenex

[ New branch ]  [ Existing branch ]

Name (optional when entering an exact branch)
[ Improve checkout speed                            ]

Branch       improve-checkout-speed             Edit
Based on     origin/main                     Choose
Environment  Automatic                       Choose

                                       [ Start task ]
```

In New branch mode, entering a name is enough: generate a branch suggestion locally as the user types. Use a readable slug such as `improve-checkout-speed`; do not require a feature/fix classification or wait for an AI naming call. The user can also enter an exact branch name and leave the task name empty. At least a name that produces a valid branch or an explicit branch name is required. An optional repository prefix can be added later without changing this flow.

The branch preview is editable in place. Until the user edits it, it follows the name. Once edited, it stays fixed while the name changes. Validate the exact final value with Git before creation. When a generated suggestion collides with an existing branch, show the next available suggestion, such as `improve-checkout-speed-2`, before submission. Also offer the matching existing branch. A collision discovered during submission must return an actionable choice rather than resetting or silently adopting the existing branch.

In Existing branch mode, immediately focus a searchable picker showing Local and Remote results together. Show recent and relevant cached branches before remote refresh completes. Preserve exact names, case, and remote identity, including branches from remotes other than origin. Do not hide a remote result merely because a local branch has the same short name. Search stays bounded and keyboard accessible. Selecting a branch and pressing Enter starts the task; a task name is optional and can be added later.

```text
New task                                        elevenex

[ New branch ]  [ Existing branch ]

[ Search local and remote branches...                ]
Local       fix/startup-delay
            main
Remote      origin/feature/checkout
            upstream/release

Name         Add a name (optional)
Environment  Automatic                       Choose

                                       [ Start task ]
```

Selecting a local branch checks out that existing branch without creating a replacement branch or resetting its tip. Selecting a remote branch refreshes that exact remote ref during preparation. If no corresponding local branch exists, create a local tracking branch from the selected remote tip and check it out. If a corresponding local branch exists at a different tip, show the difference and offer Use local branch or Review remote revision in a separate checkout; preserve the local branch. New branch mode remains available for a separately named working branch. Do not silently pull, reset, or switch the selected remote.

If a branch already has an active task, offer Open task as a quick continuation, alongside Start a separate task at this revision. The latter prepares a detached checkout at the selected commit, suitable for an independent investigation or review without taking over the existing task's files. Show the source branch and Snapshot state, and provide Create working branch if the user later wants to turn it into branch-based implementation. This is an explicit choice rather than an inferred task category. For a finished task, similarly offer Reopen task without forcing reuse of its history for an unrelated goal. Resolve checkout ownership across project links to the same local repository, not just within the currently selected project. Separate clones and separate runtimes remain independent.

No folder path or worktree inventory appears on the ordinary creation path. Environment → Choose reveals Automatic, Create a new worktree, and Choose an existing worktree. Keep the current detailed pool UI as an expert tool, simplified around these choices rather than making its full inventory the mandatory next screen.

### Choosing the base

For a new branch, choose the base in this order: an explicit repository preference, the known default branch of the selected remote, then a verified local default when there is no suitable remote. Resolve `main`, `master`, or another configured default. If the default cannot be established, require a base selection and remember the explicit repository preference. Do not silently use the branch currently checked out in the main directory.

Based on stays visible in New branch mode and opens a searchable branch/ref picker. Local branches, remote branches, tags, and a specific commit can be chosen. Existing branch mode does not show a creation-base control because it checks out the selected existing branch or revision rather than forking a new working branch from a separate base.

Opening the dialog uses cached information. Creating from a remote base refreshes that selected ref asynchronously, coalescing simultaneous fetches. Record both the selected ref and the exact commit resolved for creation. If fetching fails, offer Retry or Create from the saved ref with its last refresh time; make that fallback explicit. Do not claim that cached data is the latest remote state. A selected local ref is used as selected without a pull or reset.

Refresh the base when creating a task; never automatically rebase an existing task as new commits arrive on the default branch.

### Moving into the working view

After the backend accepts creation, close the dialog, insert the task in the sidebar, and open its working view. Show concrete preparation steps such as Refreshing base or Fetching branch, Preparing checkout, and Ready. The user can draft the first prompt while preparation runs; execution waits until the environment is ready.

Create one initial idle session using the user's existing provider preference. Focus the composer when the environment becomes ready if the user is still in that view. Creating a task does not send a prompt. If the user switches elsewhere during preparation, completion must not steal navigation or focus.

A failed preparation remains visible with Retry and Edit setup. Preserve the entered name, branch, and base. Do not rely on a disappearing toast. Repeated submissions, reconnects, and backend recovery must resolve to the same task and operation.

## Automatic worktree allocation

Automatic means Elevenex makes the ordinary decision. The server owns that decision and revalidates the chosen checkout immediately before assignment. The selected live branch or snapshot mode determines what gets checked out; the allocator must not silently replace one with the other.

Use this order:

1. If the user chose to open or resume an existing task, use its existing checkout when available. Starting a separate task must preserve its independent history and allocate separately.
2. For an existing branch checked out in a healthy, unowned, clean, app-managed worktree with no active execution, adopt that matching checkout without switching its branch or modifying its files. Unaccounted local edits require explicit adoption.
3. Otherwise reserve a healthy, unassigned, clean, app-managed worktree for this repository and runtime. Prefer an appropriate warm environment, then use a stable tie-breaker. Check candidates progressively rather than scanning every worktree first.
4. Create a worktree if no safe reusable candidate exists and the configured limit permits it.
5. If capacity is exhausted, explain the constraint in the same flow and offer available remedies: finish another task, choose an environment explicitly, or confirm creation beyond the existing soft limit.

An active task owns its checkout even when no agent is currently running. Inactivity is not permission to take it away. Automatic allocation never takes over another active task, switches a dirty checkout, or stashes somebody else's work.

Worktrees in unknown, missing, locked, conflicting, or incompatible states are excluded from automatic reuse. A candidate is unavailable while its safety checks are pending. Reservation must prevent two simultaneous creations from acquiring the same worktree; final validation must also catch changes made outside Elevenex.

The main repository checkout and externally managed worktrees are not automatically switched or recycled. If an existing branch is checked out there, explain where it is and offer explicit adoption, opening its existing task, or an independent checkout of the committed revision. Uncommitted files stay in their original checkout and are not included in a revision snapshot. An adopted external checkout remains externally managed unless the user explicitly changes that ownership. Git normally refuses checking the same branch out into another worktree, so bypassing that protection is not an allocation fallback. See the [Git worktree documentation](https://git-scm.com/docs/git-worktree).

Use neutral, stable internal pool names and paths. Renaming a task must not rename or move its checkout. Dependencies and environment setup may remain warm between assignments, but generated context and branch-dependent state must be invalidated before the next task uses the environment. Known environments opened for external use should stay reserved until explicitly released.

## Navigation and the working view

The sidebar prioritizes active tasks. Each row shows the display name, a subdued branch label when different, and at most one meaningful activity or attention indicator. Paths, pool names, and link terminology belong in environment details. Finished history is available through a Finished view or filter rather than expanded permanently into the active tree.

Clicking the task row opens its last session or initial working view. A separate disclosure control expands its sessions. Clicking a row must not merely expand it and leave the user searching for the actual working destination. Preserve session folders and existing session actions.

Keep sibling order stable while agents run or tasks receive updates. Pinning or explicit sorting can be added later; transient activity should not move the target under the user's pointer. Search and quick switching should match both the display name and branch.

The working header shows the task name, branch or source revision, and a clearly available Finish task action. Rename is available from the name and row menu. Rename changes only the display name; clearing a custom name restores branch-name display. Branch renaming is a separate Git operation and can remain outside the initial release.

Changing to an unrelated branch starts or opens another task. Replace the ordinary Switch branch action with Start another task/Open task. Advanced branch maintenance may explicitly rebind the current task when appropriate, but it must not silently rewrite its conversation history to describe another branch. If an external Git operation tasks the checked-out branch, surface Needs attention and let the user restore the intended branch or deliberately rebind it.

Use Zard controls, Tailwind utilities, and semantic color tokens. Keep the creation form quiet and compact; use progressive disclosure for optional controls. Verify light and dark mode, visible focus, keyboard operation, empty states, long names, disabled controls, preparation states, and error recovery. Essential actions must remain available without hover. Use motion sparingly and respect reduced-motion preferences.

## Finishing and reopening

Finish task means the user is done for now. It sets the finish/archive timestamp, removes the task from active navigation, closes its working tabs, and keeps its metadata and conversation history. It does not merge, push, delete the branch, or imply that a pull request was merged. Pull request automation can be added later as a separate policy.

| State when finishing | Behavior |
| --- | --- |
| Clean managed checkout, no active execution or unsaved buffers | Finish immediately, release the assignment, and keep the worktree available for reuse |
| Uncommitted, staged, untracked, or conflicting work | Finish and keep the checkout reserved with its files and index untouched; show Files kept in the finished entry |
| Unsaved editor buffers | Resolve saving in the affected view before finishing; offer Save and finish or Keep working |
| Agents, terminals, or actions executing | Show the concrete affected work and require Stop and finish or Keep working; release only after cleanup completes |
| External or main checkout | Finish the task while preserving the external checkout; do not automatically switch, detach, or recycle it |
| Missing checkout with a reachable backend | Finish while preserving history and marking the assigned environment unavailable; reconcile before any release or new assignment |
| Backend runtime disconnected | Keep the action unconfirmed and offer reconnect/retry; report completion only after backend acknowledgement |

Offer Undo after a successful finish. Undo/reopen restores the task's active state and its sessions without automatically restarting processes. If the clean worktree was already reused, acquire another safe checkout for the branch. Retained dirty work reopens in the reserved checkout.

The initial release deliberately retains dirty work instead of automatically backing up unfinished files. This makes finishing quick while preserving the actual files, staged state, and conflict state. A committed revision used for a review is distinct from a backup of local edits. Show which finished tasks retain environments when capacity is constrained. A future Save work and release action can add durable backups with a separately defined recovery contract. Git distinguishes untracked files from ignored files, so a stash workflow alone must not claim to preserve every local file. See the [Git stash documentation](https://git-scm.com/docs/git-stash).

Before making a clean managed checkout reusable, stop its managed processes and detach it at its current commit if it holds a branch. Preserve the branch and recorded final commit. Pin snapshot revisions with durable task-owned Git refs when creating the task and pin any commits made while detached before release so their history survives Git garbage collection. If process cleanup, pinning, or detaching fails, the finished task can retain its environment, but the pool must not advertise it as available.

Viewing finished conversation history does not allocate a worktree. Historical file views must not accidentally show files belonging to the worktree's next occupant. Show the recorded revision when available; otherwise make the missing historical file state explicit.

Reopen restores the existing task ID and custom name, then resolves the branch and environment. It preserves sessions that had already been archived individually. A snapshot task returns to its pinned revision even if the source branch has moved. For a task using a live branch, if that branch has been deleted, offer recreation from the recorded commit or selection of another branch. If the branch moved externally, preserve that Git state and surface the difference rather than resetting it.

Archived conversation storage must remain readable without the old working directory. Continuing a conversation after reassignment must bind its runtime to the current checkout. Provider-specific transcript lookup and resume behavior need explicit migration support; updating a path column alone is insufficient.

## Persistence and migration

The current workspace table already provides IDs and display names, while the pool provides separate worktree records. However, workspace paths and names are unique within a repository, pool relinking can reuse an existing workspace record, and some session/runtime data is keyed by path. These constraints must be addressed before environments can be reused between independent tasks. See [workspace schema](../apps/backend/src/database/schema/workspaces.schema.ts) and [worktree pool service](../apps/backend/src/worktrees/worktree-pool.service.ts).

Current sidebar name edits already update only the saved workspace label, despite the Rename worktree menu wording. The separate pool rename operation can physically move the checkout and update its linked workspace name. Preserve display-only rename behavior for tasks and keep physical environment renaming separate. Workspace removal deletes sessions, so it cannot implement finishing. See [sidebar](../apps/frontend/src/app/features/navigation/sidebar/sidebar.ts), [pool rename](../apps/backend/src/worktrees/worktree-pool.service.ts), and [workspace deletion](../apps/backend/src/workspaces/workspaces.service.ts).

Evolve the existing workspace records into durable task records while preserving IDs and session relationships. Store a nullable custom display name, selected source branch or remote ref, checkout mode (live branch or snapshot), resolved starting commit, selected base where applicable, lifecycle timestamps, and recorded final commit. Separate the current nullable worktree assignment from historical paths. Several finished tasks may have used the same physical path without owning it simultaneously.

Lifecycle and environment readiness are separate: a task is Active or Finished; its preparation can be Preparing, Ready, or Needs attention. Persist accepted creation operations and reservations so backend restarts do not lose the object that appeared in the sidebar. Git, filesystem, and database mutations need recoverable stages rather than an assumption that a SQL transaction can roll them all back. Retry reconciles partially completed work and does not reset existing branches.

Scope allocation and live branch checkout ownership to the canonical Git repository identity and backend runtime. Do not use a repository URL as identity, since separate clones are independent. At most one managed assignment owns a worktree, and at most one assignment checks out a given local branch in that repository/runtime. Multiple tasks can reference that branch; independent concurrent tasks use their own captured revisions. Do not enforce unique task identity by source branch.

Move task-owned session metadata, terminal state, and history away from path-only ownership. Repository-level command templates may remain reusable, but executions and task-specific terminal state must not leak to the next checkout occupant. Generated context must be associated with or invalidated for the assigned task and branch. Keep transcript provenance separately from the current execution directory.

Migrate regular existing workspaces to active tasks, retaining meaningful names and session folders. Prefer the saved desired branch for unlinked records; otherwise use the known current branch. Preserve unknown or detached states as Needs attention instead of inventing a branch. Keep the default workspace as a separate Repository checkout utility, with its existing sessions accessible; a permanent checkout with a mutable branch should not become a fabricated feature. Respect archived projects and existing session archive state.

Introduce a task API and agent tools for creating, listing, renaming, finishing, and reopening tasks. Route ordinary UI and agent entry points through the same allocator and lifecycle rules. Keep existing worktree APIs for explicit environment management and compatibility during migration. Database changes must use generated Drizzle migrations, never schema push.

Start with a direct repository relationship. Keep branch/assignment logic behind service boundaries so support for several repositories can later add repository associations to a stable task ID. Avoid building multi-repository orchestration in this release.

## Performance and recovery

The ordinary sidebar loads active metadata without waiting for dirty-status scans of every checkout. Refresh the selected environment and relevant visible state progressively. Finished history loads on demand. Use bounded search results and cached branch information, with stale-response guards when the repository or query changes.

Coalesce Git metadata and fetch work by canonical repository/runtime, bound concurrent Git subprocesses, and prioritize the chosen candidate. Creation and reopening run asynchronously with visible durable progress. A remote disconnection keeps the operation's last known state; reconnect reconciles it without starting a second creation.

Detect naming collisions again at mutation time. If another operation took the candidate worktree, choose another safe candidate automatically within the existing capacity policy. If setup partially succeeds, preserve the task and any created branch, display the incomplete stage, and let retry finish it. Never discard work to make a failed creation disappear.

## Implementation sequence and acceptance criteria

Implement the ownership and lifecycle rules before replacing labels. Then connect the compact creation flow and task navigation, migrate agent entry points, and verify recovery and scale. The first release includes automatic allocation, new/existing branch entry paths, independent revision checkouts when a selected branch is occupied, display renaming, finish, finished-history viewing, and reopen. Issue integrations, boards, deadlines, automatic merging, backup-based release of dirty work, and support for several repositories remain later work.

The release should satisfy these checks:

1. From a repository, a user can create a named task with one text entry and Enter, without visiting a worktree picker.
2. A user can select an existing local or remote branch, or create an exact custom branch, without entering a display name. Existing branch selection is an equally visible creation path. Remote identity and local/remote differences remain distinguishable.
3. Branch collisions, checkout ownership, offline bases, and capacity limits produce a concrete choice and preserve the entered setup.
4. A selected remote base is refreshed and its resolved commit recorded; a saved-ref fallback is explicit. New remote commits never silently rebase existing tasks.
5. Two simultaneous creations cannot own the same worktree or check out the same live branch separately. Independent tasks can reference the same source branch through isolated revision checkouts. Reconnect and retry do not create duplicate tasks or sessions.
6. Renaming a task changes its label while leaving branch, directory, session IDs, and running work untouched.
7. Finishing a clean task makes its managed environment reusable only after process cleanup and branch release. Finishing dirty work preserves the files, staged state, conflicts, and reservation.
8. Finishing one task preserves its history and leaves the project and sibling tasks active. Reading finished history works after the old checkout is reused.
9. Reopening retains the original ID and history, safely allocates if needed, and never runs a conversation in another task's environment or restarts agents without a user action.
10. Existing workspaces, session folders, unlinked records, repository-checkout sessions, and archived projects remain accessible after migration.
11. Large branch sets and rapidly moving remote history do not block ordinary navigation or force status scans of every worktree on dialog open.
12. Creation, navigation, finish, and recovery work with the keyboard, long labels, narrow windows, and both light and dark themes.
13. An investigation or PR review can start on an existing branch with no required new working branch or code edits. A separate review of an occupied branch preserves independent history and leaves the original checkout untouched. Finishing and reopening that review preserve its recorded revision.
