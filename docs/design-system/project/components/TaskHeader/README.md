# TaskHeader

The selected task has a 48px toolbar with the title, branch breadcrumb, and a **Task actions** menu. All projects can also show the project mark. Git status and actions sit beside the side-panel toggle at the right edge.

As the pane narrows, the branch label gives way to its glyph and Git actions keep their counts alongside their icons. The narrowest split panes put identity and actions on separate lines so their controls fit.

**In a project with several repositories** (`repo`): the task's `RepoTag`, a size up with the repo icon, sits before the branch. Git and Changes don't change: a task works in one repository.

Supply the task title, repo, and any branch, links, metadata, project mark, and Git state. Use `canKeepOpen` for temporary tasks and `closeSuggested` when the owner can determine that the work is ready to close.

- **Task actions** groups branch rename and copy, **Keep open** for temporary tasks, and **Close task**. Archived tasks retain branch copy.
- When `closeSuggested` is true, a labeled **Close task** button with an archive icon takes the quiet Git status slot. The actionable Git step uses the accent fill, and the side-panel toggle uses a neutral pressed state.
- Close checks for active work and local changes. Clean, idle tasks close with a `Toast` and Undo. Running or unsaved work opens `CloseTask` first.
- Reveal **Link** on hover or keyboard focus when linking is available and nothing is linked. Show it directly on touch input.
- Don't add more actions here; everything else lives in the task's ⋯ menu or ⌘K.

**Above a session in a sub-task** (`parent`): the title is the sub-task's (a sub-task has no screen of its own; this is still the session's header), and a quiet line above it names its parent, “↳ Sub-task of **Fix flaky checkout test** leo/flaky-checkout”, and opens it. The git button's next step after committing is Merge into the parent (`git.mergeInto`).
