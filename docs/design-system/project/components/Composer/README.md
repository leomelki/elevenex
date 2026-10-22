# Composer

The message box at the foot of the chat, holding every agent control without clutter: one row of quiet controls under the input, everything else one click deeper.

**The bar, left to right:** `ModeToggle` (Plan · Code) · `AgentPicker` (the session's preset; adjusts model, thinking, fast) · `PermissionPicker` (Code mode only) · then `ToolsMenu` (+: attach files, mention, MCP servers) · dictation (mic) · Stop while the agent runs · Send (or Queue while it runs).

**Provide:** `mode` (`plan` · `code`), `agent` (an AgentPicker value), `hideAgent` (on `SessionStart`), `permission` (`ask` · `edits` · `auto`), `servers` (ToolsMenu servers), `context` (attached files and mentions: `[{ kind, status, label }]`), `queue` (`[{ text }]`), `running`, `recording` (`{ time, interim }` while dictating), `placeholder`, the draft as children (or `hasText`), and `agentOpen` / `permissionOpen` / `toolsOpen` to show a menu open.

- Send: ↵ (⇧↵ newline). While the agent runs, ↵ **queues** the message and ⌥↵ **steers**: it is read at the agent's next step, without stopping it. Queued messages can be steered, edited or removed from the queue above the input.
- Stop: ⌘. or the square button, which shows only while the agent runs.
- Mode: ⇧Tab toggles Plan and Code. In Plan the agent reads and proposes but can't edit, so the permission control hides.
- Agent: ⌘J opens the picker. Presets are chosen before the first message, on `SessionStart`.
- Dictation: ⌘D or the mic; words land in the input live (muted until final), ✓ keeps them, × discards. Nothing is sent until you send.
- Dragging files over the window sets `dropping`: the edge breathes in `accent` and the box says “Drop to attach”.
- Do keep the bar to one row; new capabilities go into a menu, never as another button.
- Don't show labels on icon controls; their tooltips carry the name and shortcut.
