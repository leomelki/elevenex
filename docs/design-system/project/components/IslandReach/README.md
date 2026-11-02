# IslandReach

The title island while the window's machine is out of reach. It gets louder with time, and when only you can bring the machine back, it asks.

| Moment | It says | Tone |
| --- | --- | --- |
| Under 2 seconds | nothing changes (use `IslandName`) | rest |
| Reconnecting | "dev-box · reconnecting in 3 s", counting down | `warn` |
| After 30 seconds | "Can't reach dev-box · Try now" | `warn` |
| After 10 minutes with nothing changing | "Couldn't reconnect to dev-box · Try again". It stops trying on a clock, but a network change, a VPN connecting or the Mac waking always tries at once | `warn` |
| Only you can bring it back | first it grows once, for a few seconds (`fresh`): "dev-box needs you to reconnect · Unlock your key · Unlock". Then one line: "dev-box · unlock your key · Unlock" | `warn` |
| A changed host key | "dev-box's identity changed · Check" | `danger` |
| Back | "Back online · nothing lost", then the name | `ok` |

**Opened** (a click), it becomes the machine's panel (`MachinePanel` with `reach`):
- the countdown with Try now, or the ask (`ReconnectAsk`);
- what keeps running there and what waits to send;
- "Every window on dev-box shares this. Answer once."

Esc or a click outside closes it. It never opens by itself, because you may be typing. The line above the input offers the same ask ("It needs you · Unlock").

**Provide:** `machine`, `reach` (`{ state, in, since, tries, stoppedAt, ask, running, waiting, onTry }`), `fresh`, `open`, `onOpen`, `onClose`, `onChange`, and `panel` (passed to the `MachinePanel`, with `ask` handlers).

- Do keep one thing at a time: being out of reach outranks any event.
- Don't retry a secret in a loop: an ask waits for you.
- Do send a notification when the app is in the background and the machine needs you: "dev-box needs you to reconnect".
