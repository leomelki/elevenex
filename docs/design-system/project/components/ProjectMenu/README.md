# ProjectMenu

The project's ⋯ menu, from the sidebar head (next to New task) or a right-click on the project's rail tile. The same anatomy as every menu in the app: who it's about on top (the project's mark and name, how many repositories, the machine), rows with an icon and a quiet hint or shortcut, groups split by a line, the destructive row last.

1. **Project settings** ⌘, (opens `ProjectSettings`), **Add a repository…** (opens it on Repositories, adding), **Closed tasks** (with the count).
2. **Archive project**: no confirm; the project leaves the rail and a `Toast` offers Undo. **Delete project…** in `danger`: opens `DeleteProject` in a `ModalLayer`.

**Provide:** `project` (ProjectMark props), `repoCount`, `machine`, `closed`, and `onSettings`, `onAddRepo`, `onClosed`, `onArchive`, `onDelete`. Position it at the window level, under its anchor (never inside the sidebar, which clips).

- Don't put Rename here: name and look live in settings.
- Do keep the hints quiet: a count or a shortcut, never a sentence.
