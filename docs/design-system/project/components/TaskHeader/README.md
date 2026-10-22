# TaskHeader

The top of the main area for the selected task: project mark (all-projects view), title, the stage pill, then its branch (`BranchChip`), links and a one-line meta; on the right the `GitBar`, Close task and the side-panel toggle.

**Provide:** `title`, `stage`, optional `branch` (name), `links` (LinkChip props), `meta` (e.g. the session name · session count), `project` (ProjectMark props), `git` (GitBar props), `closeSuggested` (true when the linked PR merged or the work looks finished: Close task becomes a labelled button), `panelOpen`.

- Do keep Close task one click away at all times (the `archive` icon); it opens `CloseTask` to confirm.
- Do show “Link PR or ticket” only when nothing is linked.
- Don't add more actions here; everything else lives in the task's ⋯ menu or ⌘K.
