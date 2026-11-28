# MachineCard

One machine on Home: its kind icon (tinted with the machine's color) with a status dot, a tag on the right, the name, and one or two lines under it.

- **Connected** (`conn: 'live'`): a solid dot and what's happening now (“3 running · 1 needs you”). A tag says how many windows use it.
- **Kept** (`conn: 'kept'`): the window that was on it is picking another machine; it stays connected until a choice is made (“until you pick”).
- **Not connected** (`conn: 'idle'`): a hollow dot, a lighter card, and what we knew last, dated (“Opened 2 h ago · 3 were running”).
- **Last try failed** (`conn: 'fail'`): an amber dot and when.
- **Behind the app** (`update: '1.5.2'`): an Update tag; opening it updates it first, on the card.
- **Getting ready** (`busy: { step, progress, meta }`): connecting, installing, the engine downloading. The line says the step (it crossfades when the step changes; `meta`, like “42%”, updates in place), a `ProgressLine` along the foot fills, and the dot breathes in `running`. With `pending`, a tag says “Will open”. When `busy` goes away, the line fades out, the dot settles once (a small spring) and the line says it's ready.

- **Failed to get ready** (`error: { step, tone, progress, action }`): the error belongs to this machine, so it lives on its card. The card turns amber (`tone: 'danger'`, red, only for safety, like a changed host key), its line says what failed in one short phrase ("Stopped at 38% · you're offline", "Key not accepted for leo"), the bar along its foot stops where it failed, and the action sits in the tag's place (Try again, or `action`, like "Review the key"). The whole card is that action (`onAction`). Coming from getting ready, it gives one small shake; on first paint it doesn't.

- **Its menu** (`onMenu`): point at the card or focus it and a ⋯ fades in where the tag was (the tag, the action label and the ↵ step aside, so nothing overlaps). A right-click on the card opens the same menu at the pointer. `onMenu(machine, { x, y, card, fromButton })` says where; open `MachineMenu` there and pass `menuOpen` so the ⋯ stays while it's open. The ⋯ is a sibling of the card, never a button inside it.
- **Leaving** (`leaving`): removed, it collapses out (fades and shrinks a little in 260 ms); `MachineHome` does this for you when a machine drops out of `machines`.

**Provide:** `machine` (`{ id, name, kind: 'local' | 'ssh' | 'peer', conn, status, last, color, hue, windows, update, busy, error }`), `highlighted` (keyboard), `pressed`, `pending`, `onOpen(machine)`, `onAction(machine)` (a failed card's action; falls back to `onOpen`), `onMenu`, `menuOpen`, `leaving`. The card carries `data-machine` so `MachineLaunch` can grow it into the window.

**MachineAdd** (`kind`: `ssh` · `peer`, `onClick(card)`): an empty, dashed card that adds a machine (“A server”, “Another computer”). It hands back the card so the dialog can grow out of it (`ModalLayer`'s `from`).

- Don't show live status for a machine that isn't connected: Home never connects to anything on its own.
- Don't open a card that's getting ready: tag it pending; it opens once ready.
- Do say what failed in words a person can act on, not a code alone ("Download answered 404 · not found", not "Error 404").
- Accessibility: one control per card (the action is a label, not a second button), and its name says it all ("dev-box. Key not accepted for leo. Try again"). The error colors are the full `attention` and `danger` tokens on a tinted card: the line and the action keep 4.5:1 and the border and bar 3:1 in both themes. The island says it too, as a live status.
