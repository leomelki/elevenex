# Composer

The message box at the foot of the chat, holding every agent control without clutter: one row of quiet controls under the input, everything else one click deeper.

**Sending** (`onSend(text, { queued })`): ↵ (⇧↵ for a new line) or the send button. The button goes down to 86% at once and springs back, its arrow nudging up 4px. The input empties at once and stays focused, and the placeholder waits until the words have left. After a long message, the input gives back its height smoothly. The new user `Message` (`isNew`) then flies from where the words were. While the agent runs or the machine is out of reach, the message goes to the queue instead (`queued: true`) and doesn't fly.

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

**When its machine is out of reach** (`waitingFor: { machine, action, onAction, sending }`, `onRemoveQueued`), you can still write. ↵ puts the message in the line above the input ("2 messages wait for dev-box", `ComposerQueue`), and the placeholder says "Write now, it sends when dev-box is back…". The same goes for an answer, an approval, Stop and a new task: they're all writing, and writing waits.

Browser elements use [ElementPin](../ElementPin/README.md): picking an element drops its numbered pin (❶–❽) at the caret, its chip (thumbnail, pin, label) joins the context row, and the chip opens the historical snapshot. `@` lists the message’s pins first and ends with “Point at an element in the browser”.
