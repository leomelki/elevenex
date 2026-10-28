# TaskGroup

A task and its sessions, as an outline. Built for many sessions per task:
- **The task** is a 34px header row: a chevron (always shown, it says the task folds), its project's mark (in All projects), the title in 13.5 semibold, and its signal: “◆ 2” in `attention` when sessions need you, else how many are working, else (folded) how many sessions it has. “+” starts a new session in the task: on hover, and always on the task you're in. The header stays pinned at the top while you scroll its sessions.
- **Its sessions** are lighter 12.5 rows under a thin guide line: the working ones first (needs you, running, to review, queued), in the order they started; forks and side chats sit at the same level, with their icon.
- **Finished sessions** fold into one quiet “N finished” row that opens in place. When a session finishes it slides out of the working list and the count rolls.
- **Too many working sessions** (`cap`, default 5, a setting): the task shows its latest 5. A session that needs you, the open one and one just started always show too, wherever they are in the order. The earlier ones wait above one quiet row:
  - **At rest:** “› 9 older”, shaped like “N finished” (same chevron, 12px muted, 26px). The first row under it turns muted (its title in `ink-muted`, never by opacity, so it stays AA), so the list reads as going on above. A session that needs you, or the open one, is never muted.
  - **Each click brings back the next 5** (`capStep`), not all of them: with many sessions you click a few times. They scroll into view from under the “older” row, nearest first, pushing the rest down, with a soft edge where they come from. The count rolls, and the muted row moves up to the new first row (its title eases back to `ink`).
  - **The motion is a smooth scroll:** the batch's height animates in pixels with its rows pinned to its bottom edge, on a soft-start, long-settle curve (`cubic-bezier(0.33, 0, 0.15, 1)`), 440 to 760ms by distance. It moves at most about 15px a frame opening five rows and 22px closing ten.
  - **Show fewer:** while some are back and more are hidden, a quiet “Show fewer” sits at the right of the row; once all are back, the row itself reads “⌄ Show fewer”. Folding back scrolls them up under the row, and the count comes back.
  - **Nothing jumps:** a session that needs you, the open one or a fresh one is pulled out only while it's still hidden. One you already brought back stays where it is, even when you open it; Show fewer then keeps it in view. Archiving a row inside a batch folds it away, and the next older one slides in at the batch's top.
  - Hidden is never finished: hidden sessions keep running and keep their status. When one starts needing you, it comes into view. A filter shows every match, with no cap.
- **Archiving a session** (`onArchive`): point at a session (or tab to it) and an archive button takes the place of its diff or time. One click archives it.
  - A running session asks first, in place: the button stretches left into a red **“Stop and archive”** (the title cuts short beside it, so the name stays readable). A second click (or ↵) confirms; Esc, a click anywhere else, or moving focus away puts it back. Stopping its turn is the one thing Undo can't bring back.
  - Queued, waiting, to review, needs you and finished sessions go at once.
  - The app removes it from `sessions` (its row folds away, counts roll) and shows a `Toast`: “Archived “Cap retries at three” · Undo”. Archiving the open session moves you to the task's next working session.
  - Archiving keeps the conversation (search and @mentions find it; it comes back if the task is reopened) and changes nothing on disk: a session's edits stay in the task.
- **The task you're in** (it holds the selected session, maybe in a sub-task) shows its “+” at rest and ends with a quiet **“+ New session”** row, after its finished row. The row is muted like the finished row, with its icon and text lined up with the sessions'; its shortcut (⌥⌘N) shows on hover. It folds in and out as the selection moves to another task, and hides while a filter is on.
  - Why not show “+” on every task at rest: each row already carries a chevron, mark, title, repo tag, link and signal. A “+” on every one repeats the same mark down the list, costs every title about 24px, and pulls the eye from the signals. Shown on the task you're in, it teaches that every task has one.

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

**Provide:** `id`, `title`, `repo` (`{ name, short, hue }`, only with several repositories), `project` (ProjectMark props), `link` (or `links`; the PR wins over the ticket; shown in the row only with `showLink`, the task header always shows it), `stage` (`active` · `waiting` · `planned`: Waiting and Planned start folded), `sessions` (`[{ id, title, status, kind, meta, diff }]`), `subtasks` (`[{ id, title, branch, parent, sessions, ready, merged, diff }]`) with `onAddSub`, `selected` (session id), `filter` (a status), `collapsed`, `onAdd` (false hides “+”), `onArchive`, `cap`, `capStep`, `repo`, `fresh`.

- Do keep task rows to title and signal; the branch, links and workspace live in the task header.
- Do let a session that needs you stay where it is; the signal and the glyph say it.
