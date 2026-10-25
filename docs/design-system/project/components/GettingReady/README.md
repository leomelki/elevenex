# GettingReady

A window that's already on a machine, waiting for it: its engine updating after the app updated, and nothing else. It fills the window, centered, and **nothing from the machine shows until it's done**: an engine that doesn't match the app's version can't be trusted to draw the app.

Everything else that waits (connecting, installing, the engine downloading on first launch, an update before opening) waits on the machine's card on Home (`MachineCard`'s `busy`), and the machine opens once ready.

**Provide:** `icon`, `title`, `sub`, `steps` (`[{ label, detail, state: 'todo' | 'active' | 'done' | 'failed', progress, meta }]`; `stagedSteps(t, marks)` turns one progress value into step states), `actions` (left of the foot), `note` (right of the foot).

- Do say why it's happening in `sub` (“It has to match the app”).
- Do mirror it in the title island (“Updating dev-box 56%”), so other windows can see it too.
- Do say what failed, in one line, with Try again (a `failed` step).
- Don't offer “Update later”: the app can't show a machine whose engine is behind.
