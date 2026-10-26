# PanelTabs

The side-view switcher at the top of the side panel: Terminal, Code, Changes, Actions, Browser. Only the active tab shows its label, so five views fit in one calm control; a dot marks a view with something new (changes to review, a finished action). The raised thumb springs to the new tab; the other tabs slide aside as the label opens (FLIP, so the row is laid out once), and the label un-blurs in 40ms later. Tabs need a stable `id` (used as the FLIP key).

**Provide:** `tabs` (`[{ id, label, icon, badge }]`), `active`, optional `onSelect(id)`, `labelled` (show every label when the panel is wide).

- Do keep the order fixed: terminal, code, changes, actions, browser.
- Do open one side view at a time; the panel closes with the same toggle that opened it.
- Don't add tabs per session; views follow the selected task.
- The views behind the tabs: Changes is `DiffReview`, Browser is `BrowserView`, Terminal is `TerminalView`. Code and Actions aren't designed yet.
