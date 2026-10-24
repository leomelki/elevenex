# ProjectSettings

A project's settings: a `Sheet` in one scroll (`sections`), with the project's mark and name above the list and its face and name at the top of the scroll. The window recedes behind it, and × or Esc puts you back exactly where you were.

**Layout: the list, and one scroll.**
- On the left, the project (its mark and name) and its sections: General, Repositories (with the count), Tasks, Agents, Git.
- On the right, one scroll through all of them: the face (64px) and the name first (edited in place, with "3 repositories · dev-box · created 3 weeks ago"), then each section under its title.
- The list follows the scroll: its highlight glides (`ease-glide`) to the section you're in, and the last section lights up once you reach the end. A click scrolls there smoothly; that section stays current until you scroll yourself.
- **Not enough width** (the sheet under 680px, in a narrow window): the list goes away and the same scroll gets a sticky tab strip under the face and name, with the same highlight. Nothing else changes.
- **A × in the top corner** closes it (Esc too). Changes apply as you make them, so there's no Done or Save.

**The sections:**
- **General:** **Look** (letters, emoji or icon; six hues) and **Project**: Archive (leaves the rail, tasks stay read-only) and Delete… (`DeleteProject`).
- **Repositories:** one list. Each row: the repo icon, name and path, its tag (if set) and the branch tasks start from. A row opens in place (`Fold`) into two groups and a foot:
  - **Its tasks.** The **Tag**, a field from the start (a box with a pencil), shown next to its tasks. Empty: its name. Then **Start from**, the branch new task branches are made from.
  - **Commands.** "When a workspace is prepared" and "Before merging", each in a code well with a $.
  - **The foot.** Its tasks and sync state, and Remove from project.
  - Edits happen in place (`SetValue`): click, type, ↵ or leaving keeps the change, Esc puts it back. The commands show their pencil and fill on hover.
  The last row, **Add a repository**, turns into the path field right where the new row will be: the machine answers folder by folder as you type (`listFolders(q)` → `[{ path, git }]`), ↵ adds the highlighted one, Esc puts the row back.
- **Tasks:** branch prefix, where ⌘N puts new tasks, closing behaviour.
- **Agents:** the default preset and the Git helper preset.
- **Git:** helper sessions (Automatically · Ask first · Never, with what each means) and how sub-tasks merge.

**Provide:** `open`, `onClose`, `project` (ProjectMark props plus `look`), `repos` (`[{ id, name, short, path, base, setup, check, tasks, sync }]`), `machine`, `section` (where the scroll starts: ⌘, opens on General, "Add a repository…" on Repositories), `openRepo`, `adding`, `addQuery`, `listFolders`, `prefix`, `since`, `helpers`, and `onChange`, `onRepoChange(repo, patch)`, `onAddRepo`, `onRemoveRepo`, `onArchive`, `onDelete`.

**DeleteProject** (`project`, `tasks`, `sessions`, `running`, `machine`, `onCancel`, `onArchive`, `onDelete`): what goes (tasks and sessions, for good; running sessions stop) and what stays (the repositories and branches on the machine), with Archive instead. Shown in a `ModalLayer`; over the sheet it keeps the window back until both close.

- Do keep every setting in the one scroll, so ⌘F finds it.
- Do make the tag look like a field before any hover: it's the setting people come here for.
- Don't show examples in an opened repository: everything there can be changed, so a preview reads as one more thing to edit.
- Don't add a Save or Done: a change is saved when it's made; Remove and Delete confirm.
