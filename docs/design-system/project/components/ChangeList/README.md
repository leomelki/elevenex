# ChangeList

The changed files: status letter (M modified, A added, D deleted, R renamed), file name in bold with its folder muted, and line counts. `grouped` puts files under their folder. A file you've viewed gets a check and a muted name, and a dot marks one the agent changed since. The current file has the raised highlight, and it glides as the current file changes. It is the file list of `DiffReview` (its left column when wide, its file menu when narrow).

**Provide:** `items` (`[{ path, status, add, del, current, viewed, changed }]`), optional `grouped`, `onSelect(path)` (rows become buttons).

- Do group by repository when a task spans several.
- Don't rely on color for the status: the letter stays.
