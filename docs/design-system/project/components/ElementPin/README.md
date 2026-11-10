# Browser element mentions

Point at a page element and refer to it by name. The composer shows
`@“Save changes”` with a quiet accent-soft highlight. A sent message shows a
compact clickable mention: target-framed thumbnail, then **Save changes**.
There is no numbered disc or DOM tag in the sentence or attachment tray.

## Anatomy and interaction

- **Draft reference.** The native textarea displays the readable name. Copy,
  paste, selection, IME and undo retain native behavior. Matching complete names
  map to stable markers in the draft model and submission. Duplicate labels get
  a small qualifier. A partially edited name becomes ordinary text; its snapshot
  remains attached. Hover or focus on its card highlights the full reference.
- **Context card.** A 32px card with a 36 × 26 target-framed thumbnail and name.
  Draft cards include Remove and retry on upload failure. Uploading dims the
  thumbnail and shows progress. Unreferenced cards remain available through `@`.
- **Sent mention.** The same `ElementChip` with `inline=true`: 26px tall,
  28 × 20 thumbnail, accent-soft background, readable name. Long names truncate
  within the message width; the accessible name and snapshot retain the full
  label. Referenced elements appear inline once rather than again in a tray.
  Unmentioned elements and ordinary files keep their attachment cards.
- **Snapshot popover.** Press any mention or context card to inspect the original
  crop, externally outlined target, label, page and capture time. DOM tag and
  source hints belong here, with collapsed selector/frame/size details. Draft
  actions are **Mention in message**, **Pick again**, **Remove**, and retry on
  failure. Sent snapshots are read-only. A snapshot always describes selection
  time, never a guarantee that the page is still current.

The chip is a native button with the accessible name “button · Save changes.
Show snapshot”. The CDK popover traps focus, starts on Close and restores focus
to the trigger after Escape/outside click. Closing content stays mounted and
inert through exit. Disabled chips close any popover. Missing pixels show a
fallback icon without losing the name or interaction.

## Ownership and compatibility

The Angular conversation family owns presentation. `ElementProse` accepts
`text`, `attachments`, and the confined media `resolve`; `Attachments.mentionedText`
omits already rendered inline references. Composer stages via
`insertElement(marker)` and exposes the existing picker, retry and remove intents.
Capture, upload, lifetime and browser authority remain outside these components.

The one-character `❶`–`❽` protocol, per-message IDs, attachment associations,
queue and historical data remain compatible. `ElementPinComponent` is still
exported for existing consumers; current mention surfaces use names instead.
Removing an attachment removes all its active markers. Up to eight elements
are supported per message. No marker or highlight is burned into uploaded pixels.

## Motion and tokens

Existing mention arrival and reversible snapshot popover motion remain:
`dur-slow/ease-glide` for arrival, `dur-base/ease-glide` for popover entry,
`dur-fast/ease-in` for exit. Reduced motion applies state immediately. Use
accent/accent-soft for references, ink and surface/line for context cards,
danger/danger-soft for failures and surface-raised/shadow-pop for the popover.
The mirrored textarea layer shares the native font, wrapping and padding.

The `/element-mentions` preview stages real native snapshots. Its regression
capture covers draft names, repeated references, snapshot focus/exit, both
themes, upload/failure/disabled states, narrow layouts and sent mentions.
