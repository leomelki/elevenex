# SessionRow

One session in the sidebar, the second level under its task: a 28px row, 12.5 regular (the task above it is 13.5 semibold). Status glyph, an optional kind marker (fork, side chat, or ⚡ for a session Elevenex started for a git job), the title, then either diff counts or a short meta (time, “waiting”). Selected rows lift onto `surface-raised` (the selection glides there inside a `TaskList`); rows that need you tint with `attention-soft`. Inside a task, sessions sit at one level: a fork or side chat says what it is with its icon, not with indentation.

**Provide:** `title`, `status`, optional `kind` (`main` · `fork` · `side` · `auto`: started by Elevenex for a job, its ⚡ in `accent`), `diff` (`{ add, del }`) or `meta` (string), `selected`, `unread` (a new agent message you haven't seen), `depth` (indent steps, for standalone lists), `onClick`. Inside `TaskGroup`, give each session an `id`.

- Do title sessions by intent, as the agent or the person names them: “Reproduce flake locally”, not “Session 3”.
- Do prefer the diff over the time when there are changes.
- Do set `fresh` on a row you just created: it flashes `accent-soft` once (1.6s) so the eye finds it.
- Don't show more than one trailing item.

In the Needs you area, supply `context` (the project/task/sub-task path). This makes a two-line shortcut: session title above the muted context, without diff or time metadata. Attention rows use `attention-soft`; failed rows use `danger-soft`. Selection keeps the usual raised surface and status glyph. The normal outline keeps the compact single-line row.
