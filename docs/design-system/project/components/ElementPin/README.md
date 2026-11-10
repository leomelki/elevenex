# Browser element mentions

Point at a page element and refer to it by name. The composer shows an inline
thumbnail and **Save changes** label inside the writing line, with a small Remove
control. A sent message shows a
compact clickable mention: target-framed thumbnail, then **Save changes**.
There is no numbered disc or DOM tag in the sentence or attachment tray.

## Anatomy and interaction

- **Draft reference.** An atomic, editable-flow token containing the target-framed
  thumbnail, name and Remove. There is no duplicated element row above the text.
  Press the name to inspect the snapshot. The rich editor preserves the writing
  caret when a browser pick arrives. Backspace/Delete removes a whole reference;
  undo/redo restores its identity and position. IME input commits when composition
  ends; copy produces readable names and paste accepts plain text only.
- **Unreferenced attachment.** Erasing a prose reference keeps its snapshot visible
  below the writing line, with preview, retry and Remove. This preserves the
  attachment-only contract without silently sending hidden context. Choosing it
  from `@` inserts it inline again. Explicit Remove deletes the attachment and
  every reference. Uploading dims the thumbnail and shows progress; failure
  exposes retry. Ordinary non-element attachments retain their existing tray.
- **Inline token.** Draft and sent mentions use `ElementChip` with `inline=true`:
  20px tall inside the 22px body line, centred on the glyphs so wrapped prose
  keeps even leading; 24 × 16 thumbnail without the target frame (the snapshot
  shows it); accent-soft background; readable name; 2px side margin. Focus is a
  tight 2px outline in the token colour so it never covers neighbouring words.
  Remove is a quiet 16px control that brightens on hover/focus. A failed upload
  turns the whole token danger/danger-soft with a greyed thumbnail and retry.
- **Sent mention.** Read-only inline token. Long names truncate
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
The rich editor shares the native composer font and tokens. Upload updates retain
DOM, focus and selection; replacing a draft resets its bounded undo history.
Integrating owners focus it through `Composer.focusEditor()`; ordinary drafts
continue using the native textarea.

The `/element-mentions` preview stages real native snapshots. Its regression
capture covers draft names, repeated references, snapshot focus/exit, both
themes, upload/failure/disabled states, narrow layouts and sent mentions.
