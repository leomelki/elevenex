# Toast

A brief confirmation at the bottom of the window, with one action (usually Undo). It rises in, a thin bar shows the time left (paused while you hover), and it slips away. Used when something happened that you might want to reverse: a task closed, a session archived, a branch renamed.

**Provide:** `title`, optional `detail`, `action` (label), `tone` (`danger`), `glyph` (a status), `duration` (ms; 0 keeps it).

- Do stack at most three, newest at the bottom; never toast what the screen already shows.
- Don't use toasts for errors that need a decision; those are *Needs you*.
