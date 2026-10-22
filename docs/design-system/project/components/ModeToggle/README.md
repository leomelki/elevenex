# ModeToggle

Plan or Code, as a two-option switch at the left of the composer bar. Plan: the agent reads, asks and proposes a plan, and edits nothing. Code: it makes changes, within the chosen permissions.

**Provide:** `value` (`plan` · `code`), optional `onChange(mode)`.

- Do toggle with ⇧Tab from the input.
- Do offer “Start coding” under a finished plan; it switches to Code and sends the plan as the next message.
- Don't add more modes here; anything else is a preset or a permission.
