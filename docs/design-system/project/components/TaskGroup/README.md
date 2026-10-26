# TaskGroup

A task and its sessions, as an outline. Built for many sessions per task:
- **The task** is a 34px header row: a chevron (always shown, it says the task folds), its project's mark (in All projects), the title in 13.5 semibold, and its signal: “◆ 2” in `attention` when sessions need you, else how many are working, else (folded) how many sessions it has. “+” (on hover) starts a new session in the task. The header stays pinned at the top while you scroll its sessions.
- **Its sessions** are lighter 12.5 rows under a thin guide line: the working ones first (needs you, running, to review, queued), in the order they started; forks and side chats sit at the same level, with their icon.
- **Finished sessions** fold into one quiet “N finished” row that opens in place. When a session finishes it slides out of the working list and the count rolls.

- **Sub-tasks** sit in the task's tree after its working sessions. A sub-task is a short-lived branch off the task, with its own workspace and sessions, made to tackle one thing and merge right back.
  - **Its row:** the sub-task mark (`SubtaskGlyph`), its title in 12.5 semibold, and its signal (◆ when a session needs you, how many are working, or **Ready** once it's committed and checked). Its sessions sit under its own guide line, and the row folds them. That's all a click on it does: a sub-task has no screen of its own, only its sessions do.
  - **Any depth, one indent:** a sub-task of a sub-task sits right under its parent at the same indent and merges into that parent. The tree never gets deeper than task, sub-task, sessions.
    - **The mark says how deep:** a staircase with one step per level, ↳ for a sub-task of the task, two steps inside a sub-task, three for anything deeper. It sits in a fixed 16px slot, so titles line up at every depth.
    - **The path lights up:** the sub-task holding the selected session and every sub-task above it get an `accent` mark and guide line, so you can see what you're inside of. Titles keep their color: only sessions can be selected (a task or sub-task row only folds), so nothing but the session should look selected. Hovering or focusing a sub-task lights its own path instead.
    - **The hint names it:** after 500ms on a sub-task, a tooltip says where it lives: “In Null total… › Rounding in totals” (earlier parents shortened), or “In Fix flaky checkout test” for a first-level one. Screen readers get the full path in the row's label.
  - **Never a Christmas tree:**
    - past four open sub-tasks, the rest fold into “N more sub-tasks” (a sub-task holding the selection always shows);
    - the task's signal counts its sub-tasks' sessions, so a sub-task that needs you shows ◆ on the task;
    - merged sub-tasks leave the tree: the finished row says “2 finished · 1 merged” (the count rolls) and lists them as quiet lines with their diff.
  - **Motion:** a new sub-task grows in; a merged one collapses out while the merged count rolls in. The lit path eases its color in `dur-base`; nothing moves.

- **Several repositories in the project:** each task shows a `RepoTag` after its title: the repository's short tag (else its name), quiet, no color to learn. Tags sit at the right, before the signal, so they line up. A long one is cut (84px here) and gives way before the title does, down to two letters; hover shows the full name and path. With one repository, no tag.

**Provide:** `id`, `title`, `repo` (`{ name, short, hue }`, only with several repositories), `project` (ProjectMark props), `link` (or `links`; the PR wins over the ticket; shown in the row only with `showLink`, the task header always shows it), `stage` (`active` · `waiting` · `planned`: stages do not affect folds), `sessions` (`[{ id, title, status, kind, meta, diff }]`), `subtasks` (`[{ id, title, branch, parent, sessions, ready, merged, diff }]`) with `onAddSub`, `selected` (session id), `filter` (a status), `collapsed` (defaults to expanded), `onAdd` (false hides “+”), `repo`, `fresh`.

- Do keep task rows to title and signal; the branch, links and workspace live in the task header.
- Do let a session that needs you stay where it is; the signal and the glyph say it.
