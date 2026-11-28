# NewTask

Creating a task with the keyboard alone: **1 Name ↵ 2 Branch ↵ 3 From ↵**, and it's created. One small card (⌘N, New task in the sidebar, or pasting a ticket or PR link) with the three steps as numbered rows, all visible: the open step expands with its field and list, finished steps collapse to one line with a check, upcoming steps already show the answer you'll get (`main` *default*), and a step that isn't needed says so. Every step arrives with a sensible answer already highlighted, so the fastest path is: type a name, press ↵ three times. ⌘↵ creates at any point with what's shown; ⌥↵ saves the task as Planned instead.

**The steps:**
1. **Name**: the task's name. ↵.
2. **Branch**: one field to search or create. It starts with the name turned into a branch (`Rate-limit refunds` → `leo/rate-limit-refunds`) and lists what matches as you type: if the branch doesn't exist, the top row is **Create** it; if it does, the existing branch is on top. No New/Existing switch. Picking an existing branch still goes on to From, which says it isn't needed; ↵ there creates.
3. **From**: the branch to start from, the project default (`main`) highlighted; type to find another. Same list, no create.

Workspace (automatic) and Link (optional) sit below, unnumbered: rows you can click, never steps. Click any numbered row, or ⇧⇥, to go back to it. Esc closes the card.

**Several repositories** (`repos`, `repo`): with two or more, **Repository** becomes step 2: 1 Name ↵ 2 Repository ↵ 3 Branch ↵ 4 From ↵. It arrives preselected (the repository of the task you're in, else the last used), so ↵ keeps the fast path, and Branch and From list that repository's branches. The list ends with “Add a repository…” (`onAddRepo`), which opens project settings on Repositories. With one repository there's no step: the card stays at three, and adding a repository lives in the project's ⋯ and its settings.

**Provide:** `project` (ProjectMark props), `branches` (`[{ name, when, remote, task, isDefault }]`; `task` marks a branch another task holds), optional `bases` (defaults to the free branches), `base` (the project default), `branchPrefix` (e.g. `leo/`), `title`, `step` (`name` · `branch` · `base`, for showing a state), `branchQuery`, `baseQuery`, `hi` (highlighted row), `workspace`, `workspaces`, `workspaceOpen`, `links`, `autoFocus`, and the handlers `onCreate({ title, branch, existing, base })`, `onPlan(…)` (⌥↵), `onCancel()` (Esc). Without `onCreate` the card shows a “Created” line, for demos.

- Do keep the highlighted row the one ↵ will take, and show ↵ on it.
- The footer has no key hints. The main button does what ↵ does and says so: **Next ↵** on every step until the last, From, where it reads **Create task ↵**. Picking an existing branch still goes on to From, which then says it isn't needed (an existing branch keeps its history), so the label never changes mid-step. The label crossfades in place while the button eases to its width (`EaseSwap`), and the button is off until the step has an answer. **Save as planned** sits on the left (⌥↵ also works). ⇧⇥ and ⌘↵ work without being listed.
- Do number only the steps; extras (workspace, link) stay unnumbered so the count never lies.
- Do create the branch and claim the workspace in the background; the session opens at once and shows setup progress in its task line.
- Don't ask for a prompt here; the first message is written in the session's own composer.

The first card below is live: type a name and press ↵.

**Motion:** the open step unfolds and the previous one folds (`Fold`), the card eases to its height, and the finished step's answer fades in; focus moves to the next field at once.
