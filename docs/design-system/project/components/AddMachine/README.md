# AddMachine

Adding a machine, in a dialog over Home: **a server** (pick the host, then check its key) or **another computer** (paste its pairing text). It only asks. Once you confirm, the dialog goes back into the card it came from, the new machine's card takes that place on Home, gets ready there and opens by itself once ready.

**Provide:** `kind` (`ssh` · `peer`), and `onNext`, `onBack`, `onCancel`.
- A server: `step` (`host`, then `key`), `query`, `hosts` (from `~/.ssh/config`), `picked`, `fingerprint`, `keyType`. Connect ↵ stays off until a host is picked; on `key` it reads Trust and connect ↵ (the label eases, `EaseSwap`), and Back returns.
- Another computer: `text` (what was pasted), `found` (once understood). Pair ↵ stays off until it's found.

**Where it opens:** in a `ModalLayer` whose `from` is what was clicked (`MachineHome` hands it back: a dashed `MachineAdd` card on the first run, the foot's buttons later). It grows out of that element and, closing, goes back to the same place. Between steps the body crossfades and its height eases (`AutoHeight`).

- Do reuse what's there: the SSH config, the agent's keys, ProxyJump.
- Do keep the waiting out of the dialog: installing and connecting happen on the card.
- Don't ask for anything the machine can tell us.
