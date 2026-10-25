# MachineCard

One machine on Home: its kind icon (tinted with the machine's color) with a status dot, a tag on the right, the name, and one or two lines under it.

- **Connected** (`conn: 'live'`): a solid dot and what's happening now (“3 running · 1 needs you”). A tag says how many windows use it.
- **Kept** (`conn: 'kept'`): the window that was on it is picking another machine; it stays connected until a choice is made (“until you pick”).
- **Not connected** (`conn: 'idle'`): a hollow dot, a lighter card, and what we knew last, dated (“Opened 2 h ago · 3 were running”).
- **Last try failed** (`conn: 'fail'`): an amber dot and when.
- **Behind the app** (`update: '1.5.2'`): an Update tag; opening it updates it first, on the card.
- **Getting ready** (`busy: { step, progress, meta }`): connecting, installing, the engine downloading. The line says the step (it crossfades when the step changes; `meta`, like “42%”, updates in place), a `ProgressLine` along the foot fills, and the dot breathes in `running`. With `pending`, a tag says “Will open”. When `busy` goes away, the line fades out, the dot settles once (a small spring) and the line says it's ready.

**Provide:** `machine` (`{ id, name, kind: 'local' | 'ssh' | 'peer', conn, status, last, color, windows, update, busy }`), `highlighted` (keyboard), `pressed`, `pending`, `onOpen(machine)`. The card carries `data-machine` so `MachineLaunch` can grow it into the window.

**MachineAdd** (`kind`: `ssh` · `peer`, `onClick(card)`): an empty, dashed card that adds a machine (“A server”, “Another computer”). It hands back the card so the dialog can grow out of it (`ModalLayer`'s `from`).

- Don't show live status for a machine that isn't connected: Home never connects to anything on its own.
- Don't open a card that's getting ready: tag it pending; it opens once ready.
