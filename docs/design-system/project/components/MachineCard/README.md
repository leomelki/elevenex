# MachineCard

One machine on Home: its kind icon (tinted with the machine's color) with a status dot, a tag on the right, the name, and one or two lines under it.

- **Connected** (`conn: 'live'`): a solid dot and what's happening now (“3 running · 1 needs you”). A tag says how many windows use it.
- **Kept** (`conn: 'kept'`): the window that was on it is picking another machine; it stays connected until a choice is made (“until you pick”).
- **Not connected** (`conn: 'idle'`): a hollow dot, a lighter card, and what we knew last, dated (“Opened 2 h ago · 3 were running”).
- **Last try failed** (`conn: 'fail'`): an amber dot and when.
- **Behind the app** (`update: '1.5.2'`): an Update tag; opening it updates it first.

**Provide:** `machine` (`{ id, name, kind: 'local' | 'ssh' | 'peer', conn, status, last, color, windows, update }`), `highlighted` (keyboard), `pressed`, `onOpen(machine)`. The card carries `data-machine` so `MachineLaunch` can grow it into the window.

- Don't show live status for a machine that isn't connected: Home never connects to anything on its own.
