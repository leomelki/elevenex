# Dropdowns

Import from `ui/dropdown` or `ui`. The components use Angular CDK Menu for
overlay ownership, positioning, arrow keys, Home/End, typeahead, dismissal and
focus restoration. Their scoped CSS shares the task-stage menu's token-based
surface, rows, checkmark and reduced-motion behavior.

For a controlled single choice:

```html
<ex-dropdown label="Default preset" [value]="preset()" [options]="presets()"
  (changed)="presetRequested.emit($event)" />
```

`DropdownOption` has a stable `id`, `label`, optional `detail`, `mark` and
`disabled`. `value` is owned by the caller: `changed` emits intent and never
mutates supplied data. Unknown values remain visible without inventing an
option. Empty/all-disabled lists disable the trigger. `mono`, `icon` and
`placeholder` customize the control. `appearance="subtle"` supplies the reference
agent form’s compact 26px sunken selector; the default appearance is unchanged. Pass `active=false` when a retained owner
closes to immediately release its portaled menu; `disabled` does the same.
Destroying the component also disposes the CDK trigger and overlay.

For custom triggers, feature glyphs, grouped choices or actions, compose the
same primitives rather than extending the option model with domain concepts:

```html
<button type="button" [cdkMenuTriggerFor]="menu">Actions</button>
<ng-template #menu>
  <ex-dropdown-menu label="Task actions">
    <button exDropdownRadio [checked]="stage() === 'active'"
      (triggered)="stageRequested.emit('active')">In progress</button>
    <div role="separator"></div>
    <button exDropdownItem (triggered)="archiveRequested.emit()">Archive</button>
  </ex-dropdown-menu>
</ng-template>
```

Import `CdkMenuTrigger` from CDK in the feature. `ex-dropdown-menu` requires an
accessible `label`. Item components enhance native buttons and supply
`type="button"`. Both accept `disabled` and `typeaheadLabel` and emit `triggered`;
radio items also accept `checked` and render the selection checkmark. Action
items accept `danger`. CDK exposes unavailable items through `aria-disabled`
and prevents activation while retaining keyboard focus, so their labels are
discoverable without breaking menu traversal.

Features own triggers, content, separators, grouping and typed domain outputs.
The shared components own menu behavior and chrome, with no feature imports,
platform calls, global styles or application state. `SetChoiceComponent` is a
compatibility adapter for existing settings callers. Searchable branch and
preset pickers and forms remain specialized dialogs; do not put text fields or
other arbitrary interactive controls inside a menu.

Supply a bounded option window. For hundreds of branches or repository entries,
use the existing searchable, paginated pickers instead of rendering an entire
repository through this control.
