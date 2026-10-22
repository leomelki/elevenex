# GettingReady

The window's middle state, between Home and the machine: the local engine downloading on first launch, a server connecting, installing, or updating. It fills the window, centered, and **nothing from the machine shows until it's done**: an engine that doesn't match the app's version can't be trusted to draw the app.

**Provide:** `icon`, `title`, `sub`, `steps` (`[{ label, detail, state: 'todo' | 'active' | 'done' | 'failed', progress, meta }]`; `stagedSteps(t, marks)` turns one progress value into step states), `actions` (left of the foot), `note` (right of the foot).

- Do say why it's happening in `sub` (“Only now, because you opened it”, “It has to match the app”).
- Do mirror it in the title island (“Connecting to dev-box”, “Updating dev-box 56%”), so other windows can see it too.
- Do show it only when it takes more than a moment: a paired computer or a known server usually opens straight through.
- Don't offer “Update later”: the app can't show a machine whose engine is behind.
