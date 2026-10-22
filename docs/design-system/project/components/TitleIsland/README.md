# TitleIsland

The pill centered in every window's title bar (`TitleBar` places it: window controls on the left, the island centered). At rest it names the window's machine (its color dot, kind icon and name). It grows to say something about the machine, then shrinks back: someone connected, reconnecting, back online, updating. Clicked, it opens into the `MachinePanel`.

**Provide:** `contentKey` (change it when the content changes: the new content blurs in while the pill springs to its size), `tone` (`rest`, `info`, `warn`, `ok`), `tall` (two-line events), `open` (the panel), `progress` (0 to 1, a line along the bottom), `onClick`, and the content as children: `IslandName`, `IslandEvent`, or an icon and a short text.

- Do keep it for machine-level news only. Anything about a session (an agent needs you, a turn failed) stays in the sidebar and the chat.
- Do show one thing at a time, in this order: blocking states (updating, connection lost), then events (someone connected), then the name. Lasting states keep their tone; events shrink back after about 4 seconds and leave a small mark (`IslandName`'s `guests`).
- Do keep names short: cut them at about 22 characters; the panel shows the full name.
- Don't put buttons in the resting pill, and don't use it for toasts.
