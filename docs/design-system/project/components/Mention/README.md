# Mention

An inline chip for something referenced with @ in a message: a session (with its live status glyph), a task, or a file. Mentioning a session hands its summary and outcome to the agent.

**Provide:** `kind` (`session` · `task` · `file`), `status` (for sessions), the label as children.

- Do keep labels short: a session's title, a task id, a file name.
- Don't nest mentions or use them for links to the web.

Browser elements use [ElementPin](../ElementPin/README.md): picking an element drops its numbered pin (❶–❽) at the caret, its chip (thumbnail, pin, label) joins the context row, and the chip opens the historical snapshot. `@` lists the message’s pins first and ends with “Point at an element in the browser”.
