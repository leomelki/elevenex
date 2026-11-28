# EditMachine

Editing a machine, in a dialog that grows out of its card (`ModalLayer` with `from`): its **name** and **color**, and for a server where and how to reach it: **host**, **user · port**, **sign in with**. A paired computer shows when it was paired; This Mac can only be renamed and recolored.

- Changing the host, user or port says "Saving reconnects to check it, on its card": on Save the card gets ready again (`busy`), or shows what failed (`error`).
- The foot: **Remove** (or **Unpair**) on the left in `danger`, then Cancel and **Save ↵**. Remove acts at once (Undo in a `Toast`); a machine with a window open says **Remove…** and asks first.
- `step: 'remove'` is that question on its own (from the menu): what goes (its card, its connection, the pinned host key) and what stays (everything on the machine), and that its windows go back to Home.

**Provide:** `machine` (a `Machine` with `hue`, and for a server `host`, `user`, `port`, `key`), `step`, `onSave(patch)` (`{ name, hue, host, user, port, key }`), `onRemove`, `onCancel`.

- Do close it back into the card on Save (the dialog goes back where it came from).
- Don't ask before removing a machine nothing is open on: Undo is the safety net.
