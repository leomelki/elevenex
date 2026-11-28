# MentionMenu

What opens when you type `@` in the composer: matching sessions (with their live status), tasks (with their stage) and files, grouped, best match first. ↑↓ choose, ↵ inserts a `Mention` chip, ⇥ jumps to the next group.

**Provide:** `query`, `sessions` (`[{ label, status, meta }]`), `tasks` (`[{ label, stage, meta }]`), `files` (`[{ label, meta }]`), `hi` (highlighted index across groups), `inline` (for previews; in the app it sits above the composer).

- Do search across all projects in All projects view, and say which project a match is from (meta).
- Do insert sessions with their summary attached; the chip keeps their live status.
