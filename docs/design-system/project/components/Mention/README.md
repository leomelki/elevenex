# Mention

An inline chip for something referenced with @ in a message: a session (with its live status glyph), a task, or a file. Mentioning a session hands its summary and outcome to the agent.

**Provide:** `kind` (`session` · `task` · `file`), `status` (for sessions), the label as children.

- Do keep labels short: a session's title, a task id, a file name.
- Don't nest mentions or use them for links to the web.

Browser elements use [ElementReference](../ElementReference/README.md): a controlled snapshot card, stable @ alias and exact image association. Composer keeps cards above the textarea; MentionMenu reuses staged elements; sent Message retains read-only previews. Capture and delivery belong to platform/feature owners.
