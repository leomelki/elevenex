# Machines

Import standalone components and readonly models from `./index`. These components
render supplied state and emit intents. They never read SSH configuration, connect
to a host, copy secrets, discover peers, or open windows themselves.

The [production composition](application/README.md) wires these components to the
typed local/SSH platform. `/machine-startup` in the isolated preview exercises
that production owner with controlled lifecycle replies.

`MachineHome` filters its supplied machine list locally. `opened` includes the
machine and `newWindow` for Command/Ctrl-click or Command/Ctrl-Enter. Disconnected
cards show `last`, never their stale `status`. Machine colors are the named project
tokens, so callers cannot introduce a second palette.

`MachineLaunch` keeps `[machineHome]` and `[machineView]` projections mounted and
makes the inactive side inert. It owns and cancels all Web Animations. Stable
`machineId` matches the card's `data-machine`. A launch cover-fits the view, carries
the card face through the transition, and restores keyboard focus on return.

`TitleBar` reserves native window controls; it does not draw imitation traffic
lights. Its reference height is 34px; the shared app shell uses it too. The island
is anchored 5px from its top and centered independently of its width. TitleBar is
an inline-size container, so the island and panel use `cqw` to fit their actual
region, including embedded previews. Long event titles truncate before the action.
Lasting preparation/update status projects a
13px icon and short text directly into the compact 24px island (12px horizontal
padding, 7px gap); supply info tone and current progress. Reserve `IslandEvent`
with `tall` for rich notifications. Progress ticks keep the same content key.
`TitleIsland` keeps one measured surface: width and height spring using
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
The island uses CDK to trap focus, restores the trigger on Escape, preserves the
destination of outside pointer input, and emits `dismissed` for either dismissal.
The panel remains a keyboard destination while all of its actions are disabled.
The title-bar anchor stays at its resting height so
the panel grows down over the workspace. Its trigger and projected event action
are siblings, so there are no nested buttons. The owner applies `pressed` and
`dismissed` to its open state; machine events and their four-second expiry also
belong to the owner. The preview includes manual states and a playable sequence.
With the preview running, `pnpm desktop:capture
scripts/desktop-capture/scenarios/title-island.mjs --url http://127.0.0.1:4310`
checks spring frames, interruptions, event actions, keyboard focus, progress,
both themes, reduced motion and the composed workspace.
`scripts/desktop-capture/scenarios/title-island-states.mjs` additionally checks
all tones, machine kinds, guest/empty panels, hover, highlights, disabled focus,
keyboard action activation, progress interpolation and long names at 640/400px.

`AddMachine` replaces the old RunChoice flow. It owns one footer and composes
HostField → HostKeyCheck for `kind="ssh"`, or PairPaste for `kind="peer"`. Supply
`step`, `query`, `hosts`, `picked`, `fingerprint`, `keyType`, `text`, `found`,
`loading`, `error`, nonblocking `notice` and `disabled`. `keyRequested(PickedHost)` asks the owner for a
host key; `confirmed(AddMachineIntent)` carries either the selected host and
verified fingerprint or the found computer and pairing text. `backRequested`
and `cancelled` leave navigation with the owner. Host selection/query and pairing
text changes are controlled outputs. Enter picks a suggested host before it
advances, the key step focuses the confirmation action, and textareas keep Enter
for editing. A changed key requires clicking Confirm and invalidates
that confirmation if the host/fingerprint changes. The privileged connection
boundary must validate trust independently.

`PickedHost.portLabel` can describe an inherited SSH port without claiming it is
22. Omit it for existing resolved numeric ports and preview defaults.

`HostField` emits `queryChange`, `selected` and `submitted`, with at most eight
saved-host matches. Editing a resolved name must clear `picked` in its owner.
`HostKeyCheck.canTrust` exposes the validity of its changed-key confirmation;
it and `PairPaste` contain no action footers. `PairPaste.textChange` asks the
owner to parse/discover. Clear `found` on every text change, cancel prior work,
and reject stale replies. Only enable confirmation for a supplied found computer
without pending/error state. Pairing text is secret and must not be logged.
`PairingText.copyRequested` asks its owner to copy.

`MachineCard` accepts `machine.busy` (`step`, optional `progress`/`meta`) and
`pending`. Progress changes update in place; step changes reveal new ink; leaving
busy fades the progress line and settles the presence dot once. Busy cards remain
selectable: the owner remembers the last requested machine, starts preparation,
and launches only after it is ready and its card has settled (about 450ms).
Other selections, failures and navigation must cancel the prior pending launch.
Command/Control intents open a separate window without taking over this one.

For a failed machine with `error` and a diagnostic in `last`, `MachineMenu`
offers **View error details…** and emits the `details` action. The application
owner retains that diagnostic in a scrollable, selectable text dialog; opening
details never retries the connection. The modal owns Escape and focus return.

`MachineHome.firstRun` shows one grid and the two dashed `MachineAdd` cards.
Later visits use Connected / Not connected and footer actions. `addServer` and
`pairComputer` return the actual clicked element. Use it as `ModalLayer.from`;
keep the dialog and its supplied data mounted during its exit. Both first-run
and ordinary Home share the same machine-card components. A single keyed grid
preserves card identity across group changes. Busy/pending cards keep their group;
the launch context holds placement and grid motion through the return animation.
Cards slide into their new positions when Home is visible. `MachineGridMotion`
owns its frame snapshots and WAAPI handles, cancels on disposal/reduced motion,
and never animates a hidden Home. It is internal to this family.

`MachineLaunchComponent` owns projection lifetimes, the early card snapshot,
focus handoff and its scoped Home context. `MachineLaunchMotion` owns geometry,
cover-fit keyframes, face copies and interruption/cleanup. Both use unscaled host
coordinates, so a zoomed container cannot shift the launch origin. Reversals
resume from current progress; destination input remains usable during motion.

`GettingReady` is only for an update inside a window already on a machine.
Center it in the window in place of all machine content, and mirror progress in
the title island. Initial downloads, connecting and installation belong on Home's
cards. It shows stable-ID steps; `stagedSteps` maps progress onto ascending marks.
Engine compatibility and actual progress come from the owning integration.

All sample data and simulated operations remain outside the production entry.
`preview/machine-flow-demo.component.*` owns cancellable host/peer lookup examples,
manual preparation and last-selection-wins launch scheduling. `/machine-flow`
exercises first run, later visits, SSH/pair dialogs, errors and open-window updates.
`preview/machines-views-demo.component.*` contains the standalone machine/view
examples. Run the reusable native regression with:

```sh
pnpm desktop:capture scripts/desktop-capture/scenarios/machine-onboarding.mjs --url http://127.0.0.1:4310 --timeout 180
```

`Machine.error` supplies `{ step, tone?, progress?, action? }`. Amber (`warn`) is
the default; `danger` is reserved for safety failures. The error shows its stopped
progress and one whole-card action, named with the machine, reason and action
(default Try again). `busy` takes priority while retrying. `actionRequested`
emits a `MachineOpenEvent`, preserving new-window modifiers; without a subscriber
it falls back to `opened`. MachineHome forwards the same optional action intent.
The card nudges once on busy → error, never on first paint or under reduced motion.
Its 420ms shake applies `ease-out` between each keyframe, matching the reference
CSS. Applying that easing to the whole WAAPI effect compresses the oscillation
into its opening frames. The native regression asserts both directional peaks
and the final resting position in both themes.

`MachineHome.ping` is `{ id, at } | null`; increment `at` on every activation.
Home clears a hidden search filter, scrolls to the card and rings it in its state's
color. Repeated pings interrupt cleanly; animations are cancelled on disposal or
reduced motion. `findOpen` is a model controlling the Find field and its focus;
`findRequested` emits the pill/shortcut intent. Escape closes Find, clears its
filter and restores the pill. First run has no Find.

`machineHomeStatus(machines, pendingId)` supplies Home's priority and wording:
failures, then preparation (with progress), then the owner's Back or Machines
content. `IslandName.back` adds “Back to” and an arrow. Production Home's island
points at a failed/preparing card, reopens the still-connected machine after
Change, or opens Find. First-run rest points at the local card. The same helper
is used by `/machine-flow`; `/machine-startup` exercises the production owner.

`MachineCard.menuRequested` and `MachineHome.menuRequested` are optional
`MachineMenuEvent` outputs: `{ machine, x, y, card, fromButton }`. Subscribing
shows the sibling ⋯ on hover/focus and enables right-click and Shift+F10.
`menuOpen` keeps the affordance visible (boolean on Card, machine ID on Home).
Home supplies no menus without a subscriber. `hue` overrides the legacy named
`color` on the card, island and panel; both use the six existing project tokens.

Compose `MachineMenuComponent` with CDK, or use `MachineMenuPopupComponent` for
window-level positioning. Popup accepts the event through `request`, emits
`{ event, action }` through `action` and emits `closed` on dismissal. Clear the
request then; pass its machine ID back to Home. Menu actions are `edit`,
`new-window`, `disconnect` and `remove`. CDK owns arrows/typeahead/Escape and
outside dismissal; Popup restores the real card/menu button, preserving outside
pointer destinations. Button and pointer menus use independent CDK triggers
because CDK retains an overlay's initial positioning strategy across openings.

`EditMachineComponent` accepts `machine`, initial `step: 'edit' | 'remove'`,
`disabled`, `saving`, `error` and an optional `identityLabel`. It owns the
unfinished draft for that machine ID and emits `saved(MachineEditPatch)`,
`removeRequested`, `cancelled` and `identityRequested`. Mount it in a retained
`ModalLayer` with the event's `card` as `from`; set `disabled` as closing begins.
Create a new form identity for each new edit draft. A native identity picker
belongs to the owner: no file path, credential or platform operation enters this
presentational component. The patch's optional `key` is an intent (`default` or
`identity`); omitting it preserves an existing key choice. Empty user/port inherit
OpenSSH configuration. Name and port validity control Save. A machine with windows
switches to its removal question before emitting removal; This Mac has neither
server fields nor removal, and peers show their paired date and Unpair wording.

Remove a machine from the supplied collection immediately. Home retains its
inert card for the 260ms fade, then the grid slides surviving keyed cards into
place. Undo during exit cancels that removal; later Undo grows the card back in.
Home cancels its timers on disposal and bypasses the fade under reduced motion.
Keyboard focus moves to a surviving neighbour before the departing card is inert.
Use `ToastStack`'s existing `actionSelected(id)` and `dismissed(id)` outputs to
handle Undo and release its data. Toast actions are guarded against duplicate
activation during exit, and expiry pauses for both hover and keyboard focus.

`/machine-startup` exercises these APIs through the production composition and
an isolated platform fixture. The saved native regression is
`scripts/desktop-capture/scenarios/machine-editing.mjs`; it measures the actual
fade and subsequent neighbour travel, with keyboard, context-menu, modal-origin,
Undo, local/server, narrow, theme and reduced-motion coverage. See also the
production ownership and trust boundaries in [application/README.md](application/README.md).
