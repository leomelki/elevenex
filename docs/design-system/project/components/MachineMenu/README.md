# MachineMenu

A machine's menu, opened from its card on Home: the ⋯ that appears on hover or focus (in the tag's place), or a right-click on the card (at the pointer).

- **Edit…**: opens `EditMachine` in a `ModalLayer` with `from` set to the card, so the dialog grows out of it.
- **Open in a new window** (⌘↵).
- **Disconnect**, when it's connected (never for This Mac).
- **Remove** (a paired computer: **Unpair**), in `danger`, after a separator. It acts at once and a `Toast` offers Undo: removing only forgets the machine, nothing on it is touched, so Undo is enough. A machine with a window open says **Remove…** and asks first (`EditMachine` with `step: 'remove'`). This Mac has no Remove.

**Provide:** `machine`, `onEdit`, `onNewWindow`, `onDisconnect`, `onRemove`, optional `style` (to place it).

- Do place it under the ⋯ (right-aligned to it), or at the pointer for a right-click.
- Do give the card `menuOpen` while it's open, so its ⋯ stays shown.
