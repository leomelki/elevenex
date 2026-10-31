# Modal surfaces and settings controls

`ModalLayerComponent` takes `open` (default `true`), `align` (`center` or
`top`), and optional `from: HTMLElement | null` and emits `closeRequested` for Escape or the dim. Supply a labelled
`dialog`/`alertdialog` inside it. The layer owns a CDK portal, focus trap and
focus restoration. Keep the component mounted and change `open` to retain its
exit. Presence follows the actual animation's completion, with no independent
cleanup timer; reopening cancels the stale completion without replacing the view.
The `closed` output runs only after a completed exit has detached the portal and
restored focus. Owners can use it to hand off to another dialog while retaining
the outgoing data until that boundary; cancelled/interrupted exits do not emit it.
Keep the projected dialog/data present while the layer closes.

With `from`, the dialog morphs out of the painted trigger over 560ms and returns
over 500ms on the machine-launch curve. The box clips a uniformly cover-fit
dialog, while the trigger's copied face rides it and fades. A separate shadow
follows the box outside the clip. Closing resolves what now occupies the origin
within the same window; it measures the destination without entry/recession
transforms, so the return meets the card after Home comes forward. If the opener
has been replaced, focus can return to that replacement.

`modal-morph.ts` owns bounded keyframe generation, coordinate measurement and
inert, identity-free face copies. `ModalMotion` owns animation handles, copies,
the media listener and interrupted progress. Geometry is read at transition
boundaries; animation frames run through WAAPI, with no application rAF loop or
repository-sized observation. Every moving layer snapshots its painted values
before a reversal, including content/face/shadow opacity. Completion removes the
decorations and restores natural sizing. Disposal also restores the projected
surface's original transform origin.

Unanchored sheets/confirmations enter with a plain `dur-slow` pop on `ease-out`
and leave over `dur-base` on `ease-in`. The dim owns an inert decorative layer
and animates opacity independently of the dialog, keeping the overlay at full opacity instead of
making the whole form translucent. Reversals snapshot the painted surface and
dim separately; anchored launch morph timings remain unchanged.
Reduced motion skips the morph; a preference change finishes existing movement
and releases its resources. AutoHeight resets its baseline when a portal detaches,
so a reused dialog can open with a different body without an obsolete height.
The opener is captured before the portal attaches, so an autofocusing child
cannot replace the element that receives focus when the modal closes.
Reopening a retained layer also recaptures focus if inert blurred the outgoing
control, while preserving focus already inside the destination.

The portal escapes the transformed/inert background. A scoped
`ModalRecessionService` lease counts sheets and confirmations together. Only
the top modal receives dismissal; lower overlays become inert until it closes.
The service finds the nearest `ex-app-shell`, `.ex-window`, or
`[data-modal-window]`, then its `.regions`, `.ex-shell`, or
`[data-modal-background]`, or a machine launch's Home when there is no shell.
Import `modal-recession.css` once in the application
styles. Multiple scoped windows retain independent background counts.

For a custom CDK modal boundary, the exported `ModalRecessionService` is the
Angular counterpart of the reference's `useRecede`. `acquire(origin, overlay?)`
returns a `ModalRecessionLease`; its creator calls `release()` on close and
destruction. `isTop()` gates dismissal for nested surfaces. `ModalLayer` manages
focus, presence and the lease together for ordinary dialogs.

`SheetComponent` adds a top-aligned settings panel. Inputs are `open`, `label`,
`section`, and `sections`; outputs are `closeRequested` and `sectionChanged`.
Sections have stable IDs, a label, optional icon/count, and a `TemplateRef`.
Alternatively project `ng-template[exSheetSection]` blocks:

```html
<ex-sheet [open]="settingsOpen()" label="Settings" (closeRequested)="settingsOpen.set(false)">
  <div sheetNavHead>Settings</div>
  <div sheetHero>Settings for this project</div>
  <ng-template exSheetSection="general" label="General" icon="pencil">
    <!-- Setting groups -->
  </ng-template>
</ex-sheet>
```

All section contents share one scroll. Opening on a section is immediate;
navigation scrolls smoothly and stays selected until manual scrolling resumes.
Scroll tracking selects the final section at the bottom, including a short final
section. Below 680px of panel width, sticky horizontal section buttons replace
the sidebar; arrows/Home/End move focus and navigate. Resizing fits the thumb
without making it chase a moving layout. Without sections, project `sheetNav`
and ordinary body content, and change `page` for a body crossfade.

The settings primitives use native controls and controlled intents:

| Component | Inputs | Outputs |
| --- | --- | --- |
| `SetGroupComponent` | `title`, `note`; projected rows | — |
| `SetRowComponent` | `label`, `sub`; projected control | — |
| `SetFieldComponent` | `value`, `label`, `placeholder`, `mono`, `wide`, `disabled` | `valueChanged` |
| `SetChoiceComponent` | `options: SettingChoice[]`, `value`, `label`, `placeholder`, `icon`, `mono`, `disabled` | `changed` |
| `SetValueComponent` | `value`, `label`, `placeholder`, `mono`, `well`, `prompt`, `field`, `disabled` | `changed`, `inputChanged` |

An inline value retains only its unfinished draft. Enter or blur emits one
changed value; Escape discards it and restores the edit button's focus without
closing the sheet. `inputChanged` supplies a live preview and restores the
original value on Escape. Apply `changed` to the supplied value in the owner.
Choice controls use native select keyboard/type-ahead behavior beneath the
reference face. No control saves settings or performs platform work.

Native verification on 2026-10-24:
[modal continuity report](../../../../../../artifacts/desktop-capture/settings-final-motion-continuity/report.json)
is `verified: true`, with zero errors/warnings. It captures synchronized layer,
surface and background frames at 0/180/560ms, checks both rendered reversals
(opacity difference below .005, matrix below .002, rectangles below .05px),
then verifies reduced-motion cancellation and the original opener's focus.

`from` is also read when an exit begins. Clear it while setting `open=false` for
a successful later-project creation: the dialog leaves plainly and restores the
+ tile immediately, while focus returns after exit. Keep it for cancellation's
return morph. A new anchored draft can reopen during that plain exit; the layer
rejects the old completion and resumes from its current painted pose.

If a confirmation removes its own opener, ModalLayer returns focus to the nearest
keyboard region recorded around that opener before opening. It still prefers the
original opener or morph target when either survives, and never focuses an inert
region. This keeps machine removal keyboard-accessible after its card disappears.

`MorphFromMotion` is the shared imperative motion owner used by ModalLayer and
CommitPanel. Construct it with a layer whose first child is its surface and the
origin element. Call `retarget(open, origin)` for interrupted transitions and
`dispose()` on destruction. The optional `{ noFace: true, fadeIn: .3 }` mode keeps
the real opener visible and fades the surface during the first 30% of the morph;
it is used by the anchored commit popover. Focus, presence, sizing and dismissal
remain the consuming component's responsibility. Default ModalLayer behavior is
unchanged.
