# Machines

Import standalone components and readonly models from `./index`. These components
render supplied state and emit intents. They never read SSH configuration, connect
to a host, copy secrets, discover peers, or open windows themselves.

`MachineHome` filters its supplied machine list locally. `opened` includes the
machine and `newWindow` for Command/Ctrl-click or Command/Ctrl-Enter. Disconnected
cards show `last`, never their stale `status`. Machine colors are the named project
tokens, so callers cannot introduce a second palette.

`MachineLaunch` keeps `[machineHome]` and `[machineView]` projections mounted and
makes the inactive side inert. It owns and cancels all Web Animations. Stable
`machineId` matches the card's `data-machine`. A launch cover-fits the view, carries
the card face through the transition, and restores keyboard focus on return.

`TitleBar` reserves native window controls; it does not draw imitation traffic
lights. `TitleIsland` measures projected content, animates size, and emits `pressed`.
Give it a descriptive `label` and `controls` when it opens a panel. Its trigger and
projected event action are siblings, so there are no nested buttons. The owner
places `MachinePanel` in a CDK overlay, traps focus and restores it when closing.
Machine events and their four-second expiry belong to the owner.

`RunChoice` uses a native radio group. `HostField` emits `queryChange`, `selected`
and `submitted`; it shows at most eight saved-host matches. The owner resolves a
typed address and supplies `picked`, loading and error state. A changed
`HostKeyCheck` requires typing the hostname after checking its fingerprint;
confirmation is invalidated if that fingerprint changes. `trusted` is an intent,
and the privileged connection boundary must independently validate trust.

`PairingText.copyRequested` asks its owner to copy. `PairPaste.textChange` asks the
owner to parse/discover; it enables `paired` only for a supplied `found` computer
without pending/error state. Clear `found` when the text changes and reject stale
discovery replies in the owner. Pairing text is secret and must not be logged.

`GettingReady` shows stable-ID steps. `stagedSteps` maps overall progress onto
ascending completion marks. Engine compatibility and actual progress come from
the owning integration; the machine view must remain unavailable until ready.

All sample data and simulated intents live in the excluded preview entry point
`apps/renderer/preview/machines-views-demo.component.*`.
