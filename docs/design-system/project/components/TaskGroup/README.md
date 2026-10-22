# TaskGroup

A task and its sessions, as an outline. Built for many sessions per task:
- **The task** is a 34px header row: a chevron (always shown, it says the task folds), its project's mark (in All projects), the title in 13.5 semibold, and its signal: “◆ 2” in `attention` when sessions need you, else how many are working, else (folded) how many sessions it has. “+” (on hover) starts a new session in the task. The header stays pinned at the top while you scroll its sessions.
- **Its sessions** are lighter 12.5 rows under a thin guide line: the working ones first (needs you, running, to review, queued), in the order they started; forks and side chats sit at the same level, with their icon.
- **Finished sessions** fold into one quiet “N finished” row that opens in place. When a session finishes it slides out of the working list and the count rolls.

**Provide:** `id`, `title`, `project` (ProjectMark props), `link` (or `links`; the PR wins over the ticket; shown in the row only with `showLink`, the task header always shows it), `stage` (`active` · `waiting` · `planned`: Waiting and Planned start folded), `sessions` (`[{ id, title, status, kind, meta, diff }]`), `selected` (session id), `filter` (a status), `collapsed`, `onAdd` (false hides “+”), `repo`, `fresh`.

- Do keep task rows to title and signal; the branch, links and workspace live in the task header.
- Do let a session that needs you stay where it is; the signal and the glyph say it.
