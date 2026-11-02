# ReconnectAsk

What only you can do to bring a machine back. It lives in the island's panel (`IslandReach`, `MachinePanel`'s `reach`), on the island's dark surface.

| Kind | It asks |
| --- | --- |
| `passphrase` | "Unlock your key to reconnect": `~/.ssh/id_ed25519` is locked, and its passphrase stays on this Mac. A field, and "Keep it in the Keychain" |
| `touchid` | "Use Touch ID": macOS shows its own prompt; the ask waits with a pulsing fingerprint |
| `seckey` | "Touch your security key" (`ed25519-sk`): it waits, pulsing, until you touch it |
| `password` | "dev-box asks for leo's password. It isn't set up with a key." A field, and Keep it in the Keychain |
| `code` | a second step: six cells; it sends by itself at the sixth digit |
| `vpn` | "dev-box is only on your company network. Connect your VPN." It retries by itself when the network changes; Try now |
| `retry` | "It tried for 10 minutes and stopped at 14:12." Try again |
| `hostkey` | "dev-box's identity changed": the key isn't the one you trusted, and nothing was sent. Check the new key… opens `HostKeyCheck` in a dialog. This is the one case in `danger` |
| `pair` | "dev-box was unpaired there, or its pairing was reset." Pair again… |

- **Wrong:** the field shakes, turns red and says "That's not it. Try again.", then clears for another try.
- **Busy:** the button spins.
- **Done:** "Reconnecting…", then `onDone` (the island goes back to its machine).
- Secrets go to the Keychain if you leave Keep on, and never into Elevenex's files.

**Provide:** `kind`, `machine`, `keyPath`, `keyType`, `user`, `stoppedAt`, `onSubmit(value)` (return `false`, or a promise of `false`, when it's wrong), `onTouch`, `onTry`, `onCheck`, `onPair`, `onDone`, `onKeep`, and `state` for previews (`wrong`, `wait`, `busy`, `ok`).

- Don't ask twice: every window on that machine shares the connection, so one answer is enough.
- Don't loop: after a wrong answer it waits for you.
