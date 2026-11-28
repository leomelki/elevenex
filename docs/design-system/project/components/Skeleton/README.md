# Skeleton

Placeholders for content that's on its way: rows for lists, lines for a message. They appear only after 150ms (fast loads never flash), shimmer gently, and are replaced in place by the real content with a crossfade.

**Provide:** `variant` (`rows` · `message`), `count`.

- Do size skeletons like the content they stand for, so nothing jumps when it arrives.
- Don't show skeletons for things the app can show optimistically (a new task row appears at once).
