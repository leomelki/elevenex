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
lights. `TitleIsland` keeps one measured surface: width and height spring using
`dur-deliberate` / `ease-spring`, then incoming content blurs in after 60ms using
`dur-slow` / `ease-out`. Change `contentKey` for machine news; `open` and `tall`
also trigger the content transition. Initial content stays still, size changes
can reverse mid-flight, and reduced motion stops movement immediately.

The whole island family uses the reference's inverted surface: `ink` behind
`ink-inverse` text in both themes. Event chips, guest marks, panel sections and
keyboard hints use translucent mixes of that foreground. Tone sets the inherited
`--icon-color`; the panel sets `--kbd-background`, `--kbd-color` and `--kbd-padding`
on its keyboard hint without changing ordinary icons or hints elsewhere.
The reference's island radii, shadow geometry and compact control dimensions are
component-specific values that have no equivalent in the exported token scale.
`island-controls.css` owns the repeated event/panel chip styling and focus states.

Give it a descriptive `label` and `controls`. Supply a `TemplateRef` through
`[panel]` to grow that same surface into `MachinePanel` when `[open]` is true.
The island uses CDK to trap and restore focus, emits `dismissed` on Escape or
outside pointer input, and keeps the title-bar anchor at its resting height so
the panel grows down over the workspace. Its trigger and projected event action
are siblings, so there are no nested buttons. The owner applies `pressed` and
`dismissed` to its open state; machine events and their four-second expiry also
belong to the owner. The preview includes manual states and a playable sequence.
With the preview running, `pnpm desktop:capture
scripts/desktop-capture/scenarios/title-island.mjs --url http://127.0.0.1:4310`
checks spring frames, interruptions, event actions, keyboard focus, progress,
both themes, reduced motion and the composed workspace.

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
