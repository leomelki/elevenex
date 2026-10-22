# MachinePanel

What the title island shows when clicked. It is grouped by what each action acts on, so two very different actions never sit side by side:

1. **The machine**, with **Change** next to its name (changing acts on this window's machine; it zooms out to Home).
2. **Its connection** (servers only): connected over SSH, shared by every window on it, with Disconnect.
3. **Who else is on it** (computers you host): each connected computer, since when, with Disconnect.
4. **Other windows**: one row at the foot, New window ⇧⌘N.

**Provide:** `machine` (`{ name, kind, address, color }`), `guests` (`[{ name, since }]`), `highlight` (`change` or `new`, for the keyboard), `onChange`, `onDisconnect`, `onDisconnectGuest(guest)`, `onNewWindow`.

- Do keep labels short; the grouping carries the meaning.
- Don't add settings here. It answers “where am I, who's here, and how do I go elsewhere”.
