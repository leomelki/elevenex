# Icon

Line icons on a 16px grid, 1.5px stroke, round caps and joins; they inherit `currentColor`.

**Provide:** `name` (one of the set below), optional `size` (16 default; 14 inside small controls and rows, 12–13 inside chips and row-kind markers).

The set: `plus` `arrow-up` `terminal` `code` `changes` `actions` `globe` `fork` `side-chat` `chat` `check` `x` `chevron-down` `chevron-right` `at` `search` `commit` `push` `more` `stop` `sidebar` `panel` `attach` `repo` `task` `copy` `expand` `file` `pr` `merged` `ticket` `link` `archive` `layers` `focus` `clock` `mic` `bolt` `shield` `plug` `steer` `pencil` `trash` `plan` `branch` `workspace` `reset` `arrow-down` `bulb` `question` `laptop` `server` `peer` `key` `download` `wifi` `refresh` `grid` `window`.

- Do pair icon-only controls with a label (`IconButton` does it for you).
- Do keep fixed meanings: side views (terminal, code, changes, actions, globe), `pr` / `merged` / `ticket` for links, `archive` for closing a task, `layers` for all projects, `focus` for focus mode, `plan` for Plan mode, `bolt` for fast mode, `shield` for permissions, `plug` for MCP, `steer` for steering, `mic` for dictation, `branch` for git branches (never for forks), `workspace` for workspaces, `reset` to restore a suggestion, `bulb` for thinking, `arrow-down` to jump to new messages; for machines, `laptop` (this computer), `server` (over SSH), `peer` (a paired computer), `key` (SSH keys), `wifi` (a lost connection), `refresh` (an update), `download` (the engine downloading), `grid` (Home, all machines), `window` (a new window).
- Don't fill icons or mix stroke weights; status uses `StatusGlyph`, task stage uses `StageGlyph`.
