# Task and navigation components

Import public components and readonly view models from `./tasks`. Components use signal inputs, typed intent outputs and OnPush change detection. This family has no platform calls, git operations, clipboard access, repository scans or application store. The feature that supplies the inputs owns those operations and feeds the result back through inputs.

`projects/` owns project identity and scope navigation. `outline/` owns the two-level task/session outline. `lifecycle/` owns task context, stages, links and closing. `branches/` owns the new-task form and branch/workspace selection. `navigation/` owns task side views and git actions. `task.models.ts` contains renderer view contracts; it does not replace privileged IPC contracts in `packages/shared`.

| Component | Main inputs | Intent outputs |
| --- | --- | --- |
| `ProjectMark` | `name`, `logo`, `initials`, `hue`, `size`, `decorative` | None; broken logos fall back to the monogram |
| `ProjectRail` | `projects`, `all`, `activeId` | `selectProject(id)`, `addProject()`, `reorderProjects(ids)` |
| `StatusSummary` | `counts`, `active` | `selectStatus(status or null)`; a second click clears the filter |
| `StageGlyph` | `stage`, `size` | None |
| `TaskStage` | `stage` | `stageChange(stage)` |
| `LinkChip` | `kind`, `label`, `state`, `href`, `compact` | `activated()` |
| `TaskHeader` | `title`, `stage`, `branch`, `links`, `meta`, `project`, `git`, `closeSuggested`, `panelOpen`, `branchCopied` | `stageChange`, `closeRequested`, `panelToggle`, `branchRename`, `branchCopy`, `linkRequested`, `linkActivated(link)`, `gitAction`, `changesRequested` |
| `CloseTask` | `title`, `sessions`, `running`, `unpushed`, `ticket` | `confirmed({push, moveTicket})`, `cancelled()` |
| `TaskLine` | `task: TaskContext`, `branchCopied` | `renameRequested()`, `branchRename(name)`, `branchCopy(name)` |
| `BranchPicker` | `query`, `branches` or precomputed `items`, `allowCreate`, `base`, `highlighted`, `label`, `listId` | `pick(row)` |
| `BranchChip` | `name`, `base`, `compact`, `copied` | `renameRequested(name)`, `copyRequested(name)` |
| `WorkspacePicker` | `value`, `items` | `valueChange(name or 'auto')`, `newWorkspace()`, `manageWorkspaces()` |
| `NewTask` | `project`, `branches`, `bases`, `base`, `branchPrefix`, initial `title`, initial `step`, initial `branchQuery`, `workspace`, `workspaces`, `links`, `autoFocus` | `create(CreatedTask)`, `plan(PlannedTask)`, `cancelled()`, `linkRequested()`, `projectRequested()`, `workspaceRequested('new' or 'manage')` |
| `SessionRow` | `session`, `selected`, `depth` | `activated(sessionId)` |
| `TaskGroup` | `task`, `selected`, `filter`, `showProject`, `showLink`, `allowAdd` | `selectSession(sessionId)`, `addSession(taskId)` |
| `TaskList` | `tasks`, `selected`, `filter`, `showProjects` | `selectSession({taskId, sessionId})`, `addSession(taskId)`, `closedRequested()` |
| `PanelTabs` | `tabs`, `active`, `labelled`, `label` | `selectTab(id)` |
| `GitBar` | `files`, `add`, `del`, `ahead`, `busy`, `compact` | `action(GitAction)`, `changesRequested()` |

The `Component` suffix and `ex-` selector prefix apply to the names above. `branchItems`, `branchFromTitle`, `validBranchName` and `matchesSessionFilter` are pure exported operations, independently testable without rendering.

## Ownership and interaction

- Use stable task, session, project and tab IDs. TaskList renders a single keyed outline, so stage changes preserve the task component and local folds. Filtering keeps hidden task components mounted and inert. Sessions keep their original order; a question changes its signal rather than moving its row. Done sessions fold into one count, and the selected finished session opens that fold.
- Feed a bounded task/session window into the outline; request pagination in the owning feature. BranchPicker shows at most seven results. It matches every query word, promotes exact/default matches and retains the caller's recency order among equal matches. Held branches remain visible but cannot emit a pick. From excludes held branches. Input validation improves the form; privileged git handlers must validate again.
- NewTask keeps its draft locally. Name → Branch → From uses Enter, arrows change the highlighted branch, Shift Tab returns to a prior step, Cmd/Ctrl Enter creates immediately, Alt Enter saves Planned and Escape emits cancellation. Existing branches skip From. Initial form inputs are read once: destroy/recreate the form to open another draft. The chosen branch and base are rechecked against current supplied data before creation. Workspace selection is included in both create/plan payloads.
- The owner handles branch rename/copy requests and supplies `copied` or `branchCopied` after a successful copy. LinkChip emits activation so the owner can validate the URL and use the existing platform boundary. It never navigates an untrusted renderer URL directly.
- CDK menus supply keyboard navigation and focus restoration for stage/workspace/git menus. CloseTask owns its modal backdrop, CDK focus trap and cancellation. Render it conditionally; remove it when an output resolves the dialog. If no running sessions or unpushed work would be affected, the feature may close immediately and offer Undo. NewTask is a reusable card; a feature that presents it modally owns its dialog boundary.
- PanelTabs implements automatic activation with arrows/Home/End and roving focus. Provide `panelId` on a tab to connect it to the owning feature's tabpanel. Global project shortcuts and new-task shortcuts belong to that feature. Project reorder supports drag/drop and Option Shift Up/Down while a tile is focused; the owner applies the requested ID order.
- GitBar keeps a single primary native button across commit/push/busy states. Busy disables its git actions, leaving the rest of the task usable. Combinations emit explicit intents so no component assembles a shell command.

The isolated showcase is `apps/renderer/preview/tasks-demo.component.*`. Its sample projects, tasks and handlers stay outside the production renderer source graph. Unit tests cover branch validation/filtering, the keyboard creation flow, held branches, task identity across stage/filter changes, finished folds, tab navigation and emitted intents.
