# TitleIsland

The pill centered in every window's title bar (`TitleBar` places it: window controls on the left, the island centered). At rest it names the window's machine (its color dot, kind icon and name). It grows to say something about the machine, then shrinks back: someone connected, reconnecting, back online, updating. Clicked, it opens into the `MachinePanel`.

**Provide:** `contentKey` (change it when the content changes: the new content blurs in while the pill springs to its size), `tone` (`rest`, `info`, `warn`, `ok`), `tall` (two-line events), `open` (the panel), `progress` (0 to 1, a line along the bottom), `onClick`, and the content as children: `IslandName`, `IslandEvent`, or an icon and a short text.

- Do keep it for machine-level news only. Anything about a session (an agent needs you, a turn failed) stays in the sidebar and the chat.
- Do show one thing at a time, in this order: blocking states (updating, connection lost), then events (someone connected), then the name. Lasting states keep their tone; events shrink back after about 4 seconds and leave a small mark (`IslandName`'s `guests`).
- Do keep names short: cut them at about 22 characters; the panel shows the full name.
- Don't put buttons in the resting pill, and don't use it for toasts.

**On Home** (no machine yet, the first run included). The island still tells one thing at a time, most urgent first, and a click always leads somewhere:

| It says | When | Clicking it |
| --- | --- | --- |
| **“Couldn't download the engine”**, **“Couldn't reach dev-box”** (`warn`, amber; the safety case says so too) | a machine failed to get ready | points at that card: Home scrolls to it, the card springs a little and sends one ring in amber (red for safety), so you see which machine and its Try again |
| **“Getting ready 42%”**, **“Setting up dev-box 60%”**, **“Connecting to dev-box”** (`info`, with `progress`) | a machine is getting ready | points at that card (one ring in `running`) |
| **“Back to dev-box”** (`IslandName` with `back`: its dot and icon, a back arrow) | the window just left that machine with Change and still holds its connection | opens it again: the card grows back into the window (the launch). Change is rare and often a quick look, so this is its undo |
| **“Machines”** (a grid icon) | nothing is happening | opens Find (⌘O), the search at the top of Home. On the first run, which has no search, it points at This Mac instead: the card to open |

The first screen, in order: **“Getting ready 42%”** while This Mac's engine downloads, then **“Machines”**; or **“Couldn't download the engine”** if it fails. Each click leads to This Mac's card. Pair it with `MachineHome`'s `ping` (`{ id, at }`) and `onFind`.
