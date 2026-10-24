# TaskHeader

The top of the main area for the selected task: project mark (all-projects view), title, the stage pill, then its branch (`BranchChip`), links and a one-line meta; on the right the `GitBar`, Close task and the side-panel toggle.

**In a project with several repositories** (`repo`): the task's `RepoTag`, a size up with the repo icon, sits before the branch. Git and Changes don't change: a task works in one repository.

**Provide:** `title`, `repo`, `stage`, optional `branch` (name), `links` (LinkChip props), `meta` (e.g. the session name · session count), `project` (ProjectMark props), `git` (GitBar props), `closeSuggested` (true when the linked PR merged or the work looks finished: Close task becomes a labelled button), `panelOpen`.

- Do keep Close task one click away at all times (the `archive` icon); it opens `CloseTask` to confirm.
- Do show “Link PR or ticket” only when nothing is linked.
- Don't add more actions here; everything else lives in the task's ⋯ menu or ⌘K.

**Above a session in a sub-task** (`parent`): the title is the sub-task's (a sub-task has no screen of its own; this is still the session's header), and a quiet line above it names its parent, “↳ Sub-task of **Fix flaky checkout test** leo/flaky-checkout”, and opens it. The git button's next step after committing is Merge into the parent (`git.mergeInto`).
