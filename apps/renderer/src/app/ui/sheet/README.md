# Modal surfaces and settings controls

`ModalLayerComponent` takes `open` (default `true`), `align` (`center` or
`top`), and optional `from: HTMLElement | null` and emits `closeRequested` for Escape or the dim. Supply a labelled
`dialog`/`alertdialog` inside it. The layer owns a CDK portal, focus trap and
focus restoration. Keep the component mounted and change `open` to retain its
220ms exit; reopening interrupts that exit safely. Reduced motion disposes it
without movement. The layer's owner always disposes its timer and overlay.
The actual projected dialog is the animation surface, so its transform origin
matches its own box. With `from`, the origin is the clicked element's center,
measured once in unscaled coordinates; disposal restores the projected surface's
original transform origin. The dialog grows from scale .42 over
460ms and returns there over `dur-base`; the origin survives exit/reversal.
Keep the projected dialog/data present while the layer closes. Initial entry uses the reference CSS; reversals snapshot
the painted opacity/transform before cancelling owned animations and retarget
from that frame. Reduced-motion updates and disposal cancel those handles.
The opener is captured before the portal attaches, so an autofocusing child
cannot replace the element that receives focus when the modal closes.

The portal escapes the transformed/inert background. A scoped
`ModalRecessionService` lease counts sheets and confirmations together. Only
the top modal receives dismissal; lower overlays become inert until it closes.
The service finds the nearest `ex-app-shell`, `.ex-window`, or
`[data-modal-window]`, then its `.regions`, `.ex-shell`, or
`[data-modal-background]`. Import `modal-recession.css` once in the application
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
