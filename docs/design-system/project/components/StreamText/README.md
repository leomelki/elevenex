# StreamText

Agent text as it streams: each new piece fades in over `dur-slow` behind a blinking `accent` caret, so reading feels continuous instead of jumpy. The caret disappears when the turn ends.

**Provide:** `text` (everything received so far), `streaming` (true while the turn is live), optional `demo` (types `text` out for previews), `speed`.

- Do keep the view pinned to the bottom only while you're already at the bottom; otherwise show `NewMessagesPill`.
- Don't animate history: only text that arrives while you watch fades.
