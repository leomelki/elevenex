# WorkspacePicker

Where the task's files live. **Automatic** (the default) reuses a free workspace from the project's pool, already set up with dependencies so the task is ready quickly, or adds a new one to the pool. The menu lists the pool, free and in use, for when you want to choose.

**Provide:** `value` (`auto` or a workspace name), `items` (`[{ name, state: 'free' | 'used', note, task }]`), `open`.

- Do keep it set to Automatic for nearly everyone; it is shown, never asked.
- Do return a closed task's workspace to the pool, cleaned, rather than deleting it.
- Do say *workspace* in the interface; the word *worktree* appears only in Manage workspaces, next to each one's path.
