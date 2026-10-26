# TaskList

The sidebar's body: a compact **Needs you** area followed by one stable **Tasks** outline. Stages belong in the task header, not in sidebar sections. A task is a `TaskGroup`: a header row that stays pinned while you scroll its sessions, the sessions under a guide line.

**What moves, and what doesn't:**
- Questions, permissions, decisions and failed sessions get a shortcut in **Needs you**. Show three initially, with a count and a Show more / Show fewer control. Existing requests keep their order and new requests append, even if the owning feature reorders its tasks. Each shortcut names the session and its project/task/sub-task context; omit project names in a single-project view. Hide the whole area when no session needs attention. Closed tasks and merged sub-tasks never contribute.
- The original session is **marked, never moved**: its glyph and row tint identify the request or failure, and its task shows “◆ 1”. Shortcuts open that session and reveal any folded task or sub-task containing it. You answer in the session, where the context is; resolution removes the shortcut.
- To see only what needs you, filter: pass `filter: 'attention'` (wire it to `StatusSummary`'s Needs you). Everything else folds away; clearing it folds everything back.
- Task stage changes leave order and local fold choices untouched. Tasks start expanded unless explicitly supplied as collapsed. A status filter hides the shortcut area to avoid repeating the filtered sessions.
- New tasks and sessions grow in; a closed task fades and its space closes; finished sessions slide into their task's “N finished” row; the selection glides from row to row.

**Provide:** `tasks` (`[{ id, title, project, stage, link | links, sessions: [{ id, title, status, kind, meta, diff }] }]`), `selected` (a session id), `filter` (a status, or null), `showProjects` (false in a single project's view), `onAdd(task)` (the “+” on a task's header).

- Do give every task and session a stable `id`; motion follows ids.
- Do keep the supplied order of tasks stable, independent of stage or session status.
- Don't put approvals or other actions in the sidebar; it says where to look, the session is where you act.

The card plays the moments on its own; Step goes one at a time.
