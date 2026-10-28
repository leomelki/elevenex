# TaskHeader

The top of the main area for the selected task: project mark (all-projects view), title, the stage pill, then its branch (`BranchChip`), links and a one-line meta; on the right Close task and the side-panel toggle; below them the `GitBar`.

**In a project with several repositories** (`repo`): the task's `RepoTag`, a size up with the repo icon, sits before the branch. Git and Changes don't change: a task works in one repository.

**Provide:** `title`, `repo`, `stage`, optional `branch` (name), `links` (LinkChip props), `meta` (e.g. the session name · session count), `project` (ProjectMark props), `git` (GitBar props), `closeSuggested` (true when the linked PR merged or the work looks finished: Close task turns accent), `onClose`, `panelOpen`.

- Do keep Close task one click away at all times. We can't know when someone is done: while working, after a push, or long after a merge.
- **Close task is a quiet word:** “☑ Close task” in muted text, no border, a ticked square (the `close-task` icon, the Closed stage's shape) rather than an archive box. A thin line sets it apart from the side-panel toggle, so task actions and view controls don't mix. It fills on hover.
- When the work looks finished (`closeSuggested`), it turns accent. It never appears, moves or grows because of it.
- On click: nothing would be lost, so it closes at once with a `Toast` and Undo; or something would be (a running session, uncommitted or unpushed work), so it opens `CloseTask` first.
- Do show “Link PR or ticket” only when nothing is linked.
- Don't add more actions here; everything else lives in the task's ⋯ menu or ⌘K.

**Above a session in a sub-task** (`parent`): the title is the sub-task's (a sub-task has no screen of its own; this is still the session's header), and a quiet line above it names its parent, “↳ Sub-task of **Fix flaky checkout test** leo/flaky-checkout”, and opens it. The git button's next step after committing is Merge into the parent (`git.mergeInto`).
