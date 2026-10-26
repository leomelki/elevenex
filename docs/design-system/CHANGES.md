# What changed since the last zip

One change: **editing and removing a machine**, from its card on Home. It's in the components (`bundle.js`, `bundle.css`), the types (`index.d.ts`), the READMEs and the brand book (`project/README.md`, Machines section). The gallery now has 85 cards: `MachineMenu` and `EditMachine` are new.

## On the card: ⋯ and right-click

- `MachineCard` and `MachineHome` take a new `onMenu(machine, { x, y, card, fromButton })`.
  - With it, pointing at a card (or focusing it) fades in a ⋯ where the tag was. The tag, a failed card's action label and the ↵ step aside, so nothing overlaps.
  - A right-click on the card calls the same `onMenu` at the pointer.
- The ⋯ is a sibling of the card, never a button inside it. When `onMenu` is set, the card is wrapped in `.ex-mcard-wrap`, which carries `data-key`. The card button keeps `data-machine`, so `MachineLaunch` still finds it.
- While the menu is open, pass `menuOpen`: the machine's id to `MachineHome`, `true` to a single `MachineCard`. The ⋯ then stays shown.

## The menu: `MachineMenu` (new)

- The items are:
  - Edit…;
  - Open in a new window (⌘↵);
  - Disconnect, only when connected, never for This Mac;
  - then Remove in `danger`. A paired computer gets Unpair instead, and This Mac has no Remove.
- Place it under the ⋯, right-aligned to it, or at the pointer for a right-click.

## Edit: `EditMachine` (new)

- Open it in a `ModalLayer` with `from: card`, so it grows out of the card, and it closes back into the card on Save.
- It edits:
  - the name and the color;
  - for a server: host, user · port, and sign-in. Changing where it is says "Saving reconnects to check it, on its card". On Save, the card goes back to getting ready (`busy`), or shows what failed (`error`).
  - for a paired computer: it also shows when it was paired;
  - for This Mac: only the name and color.
- `onSave(patch)` receives `{ name, hue, host, user, port, key }`.
- `Machine` gained optional fields for this: `hue`, `host`, `user`, `port`, `key`, `paired`.

## Removing: at once, with Undo

- Removing only forgets the machine: its card, its connection and the host key we saved. Nothing on the machine is touched, so Undo is enough.
- On Remove:
  - drop the machine from `machines` right away;
  - `MachineHome` fades its card out (260 ms), then slides the others over;
  - show a `Toast`: "Removed staging-1 · Nothing on it was touched · Undo".
  - Undo puts the machine back at its index, and the card grows in where it was.
- Exception: a machine with a window open asks first. The menu item reads "Remove…" and opens `EditMachine` with `step: 'remove'`. That screen says what goes, what stays, and that its windows go back to Home.
- `Toast` now has `onAction` and `onClose`, so its action and × buttons call something. Before, they did nothing.

Try it in the top window of the `MachineHome` card: hover dev-box for the ⋯, open Edit…, then right-click staging-1 and Remove it, and Undo.
