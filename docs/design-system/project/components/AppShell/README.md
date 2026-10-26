# AppShell

The whole window composed from the system, in the All projects view: the title bar with the window's machine in its island (`TitleBar`, `TitleIsland`), then the project rail, sidebar (status summary, then tasks grouped by stage with their sessions), the main chat for the selected session under its task header, and one side panel. A showcase page, not a bundle export.

**Composition:** `canvas` ground with `space-2` gutters; rail and sidebar are `glass`; main and side panel are `surface` with `shadow-glass` and `radius-lg`.

- Do keep four regions at most; the side panel closes to give the chat the room.
- Do let the Changes panel take over the chat's place for a review (the expand icon, ⇧⌘R, `usePanelTakeover`): the rail and sidebar stay, and Esc brings the chat back. The preview's expand icon does it.
- Do switch scope from the rail: All projects shows every task with its project mark; a single project hides the marks and adds the Focus toggle to the sidebar header.
- Do keep the sidebar foot to the Closed list and the ⌘K hint.
- Don't add a top app bar; ⌘K opens the command palette over everything. The title bar is window chrome: the window controls and the island, nothing else.
