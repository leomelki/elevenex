# BranchPicker

The list under a branch field: branches matching what you typed (every word must appear; matches underlined in `accent`), newest and default first. With `allowCreate`, a name that doesn't exist yet gets a **Create** row on top, so one field both finds and creates; a name git won't accept gets a `danger` row with the rule instead. Branches another task holds are listed but can't be taken.

**Provide:** `query`, `branches` (`[{ name, when, remote, task, isDefault }]`), `allowCreate` (branch step: true; base step: false), `base` (shown on the Create row), `hi` (highlighted index), optional `onPick(item)`, `label`. `branchItems(query, branches, allowCreate)` returns the rows, for keyboard handling.

- Do keep ↵ on the highlighted row and ↑↓ to move; never more than seven rows.
- Do rename later from the branch chip; after the first push, renaming also renames it on the remote, and says so.
