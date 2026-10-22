# TaskList

The sidebar's body: every task, by stage (In progress, Waiting, Planned), each group counted. A task is a `TaskGroup`: a header row that stays pinned while you scroll its sessions, the sessions under a guide line.

**What moves, and what doesn't:**
- A session that needs you is **marked, never moved**: its glyph turns `attention` and its task shows “◆ 1”. Tasks keep their place, so the sidebar doesn't reshuffle every time an agent asks something. You answer in the session, where the context is.
- To see only what needs you, filter: pass `filter: 'attention'` (wire it to `StatusSummary`'s Needs you). Everything else folds away; clearing it folds everything back.
- A task that changes stage travels to its new group (a `FlipScope` glide) and, arriving in Waiting or Planned, folds once it's there.
- New tasks and sessions grow in; a closed task fades and its space closes; finished sessions slide into their task's “N finished” row; the selection glides from row to row.

**Provide:** `tasks` (`[{ id, title, project, stage, link | links, sessions: [{ id, title, status, kind, meta, diff }] }]`), `selected` (a session id), `filter` (a status, or null), `showProjects` (false in a single project's view), `onAdd(task)` (the “+” on a task's header).

- Do give every task and session a stable `id`; motion follows ids.
- Do keep the order of tasks stable within a stage (by when they started), not by status.
- Don't put approvals or other actions in the sidebar; it says where to look, the session is where you act.

The card plays the moments on its own; Step goes one at a time.
