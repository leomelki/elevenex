# ProjectRail

The leftmost glass strip for moving between projects. The top tile is **All projects** (⌘0): every task from every project in one sidebar. Below it, one tile per project (⌘1–⌘9) showing its `ProjectMark`, with an amber count when sessions need you and a running ring when agents are working. The active indicator slides to the tile you open; counts pop in when they change.

**Provide:** `projects` (`[{ id, name, logo, initials, emoji, icon, hue, attention, running, muted }]`), `all` (`{ attention, running }` totals, or `false` to hide the tile), `activeId` (`'all'` or a project id), optional `onSelect(id)`.

- Do pick the working mode by where you click: All projects to triage everything, one project to focus on it.
- Do mark projects muted while focusing (Focus mode, the `focus` toggle in the sidebar header): their tiles dim and drop their counts until you leave focus; nothing is lost, it waits in All projects.
- Do show attention over running: a tile shows the count, else the ring, else nothing.
- Do let people reorder tiles by dragging; the order sets the ⌘ number.
- The add tile (+) opens `NewProject` in a `ModalLayer`. A new project's face jumps from the card into its tile and the tile settles (`jumpHome`, `settleMark`).
- Don't put anything else in the rail besides the add tile (settings live in the account menu).
