# ElementPin

Point at a page element and talk about it. Each element a person picks in the
task browser becomes a numbered **pin** in their message, so they can write
“Align ❶ with ❷” the way they would while pointing at a screen. The pin is the
reference; its chip holds a real screenshot of the element taken at the moment
it was picked, with a little of the page around it.

A pin shows the page **at selection time**. It never implies that the page,
element or locator is still current.

## Anatomy

- **Pin.** A small accent disc with the element's number (1–8 per message). Filled
  when the prose refers to it; hollow (accent ring) when the element is attached
  but not yet mentioned. Danger when its upload failed. Decorative: the owning
  control or text names it.
- **Prose marker.** In the textarea a pin is one character, ❶–❽. One Backspace
  deletes it, it survives copy and paste, IME and undo, and it can't be
  half-edited into another reference. A soft accent mark sits behind each marker
  (a mirror of the textarea's text, not an editor). Hovering or focusing a chip
  rings its markers. A marker with no element in this message turns danger and
  blocks Send with a repair explanation.
- **Chip.** 32px tall in Composer's context row, beside session mentions: a 36 × 26
  thumbnail framed on the target (the target fills most of it, with a thin,
  translucent dashed accent outline offset outside its border; pixels are never
  magnified past 1.5×), the pin, then the label as
  `tag` (mono, muted) and readable name. Editing chips end with × (and a retry
  arrow when an upload failed). Uploading dims the thumbnail and runs a 2px
  progress line along its foot. Sent messages show the same chip, read-only.
- **Snapshot popover.** Pressing a chip opens an anchored dialog (above the chip,
  or below if there's no room): the whole crop on a sunken well with a 1px dashed,
  translucent outline 4px outside the target, the pin beside the name, `host/path · Picked
  1:14 PM`, the page's source hint (`code` file:line · “As reported by the page”)
  when there is one, a one-line historical note, and collapsed Technical details
  (selector, frames, size). Draft actions: **Insert ❶** at the caret, **Pick
  again** in the original tab, **Remove**. Sent snapshots have no actions.

Missing source never blocks a pin. No selector, geometry or other technical
payload enters the writing area. The outline leaves the target and its border
uncovered, with no fill, halo or pin over the image. Nothing is injected into the
website or burned into the captured pixels; agents receive the original crop.

## Mentioning

- **Pick in the browser.** The browser's target button, ⌖ in the Composer bar, or
  `@` → “Point at an element in the browser”. Click an element and its pin drops
  at the caret, spaced from the surrounding words, and focus returns to the
  message. There is no intermediate question card in the browser panel; the
  picked ring locks in, and the chat is where you write.
- **Reuse a pin.** `@` lists “Elements in this message” first (pin, label, host);
  choosing one inserts its marker in place of the `@query`. The popover's
  Insert does the same.
- **Numbers are stable.** A new element takes the lowest number not on the draft,
  and keeps it through upload, retry, queue and history. Removing a chip removes
  its markers from the prose (keeping one space between words), so a number is
  never silently reassigned while text still points at it. The same snapshot
  added twice keeps one pin and one upload. Up to 8 per message.

## Behavior

The Angular implementation in the conversation family is canonical:
`ElementPinComponent` (`marker`, `hollow`, `size`, `tone`), `ElementChipComponent`
(`file`, `resolve`, `editing`, `disabled`, `mentioned`, `pickAvailable`; outputs
`removed`, `retry`, `mention`, `repick`, `highlighted`), `ElementPreviewComponent`
(the popover body, also used inline for agent-requested picks; tight regions may
lower `--element-preview-image-height`, 260px by default, and set `compact` to
drop the historical note and technical details) and
`ElementProseComponent` (sent prose with markers drawn as pins). Element data is
`ConversationAttachment.element` plus `ConversationAttachment.marker`. Composer
adds `elementPickAvailable`, `elementPickRequested`, `elementRepick` and the
`insertElement(marker)` operation. Capture, upload, selection ownership and
delivery live outside these components.

The chip is a native button with a full accessible name (“Pin 2, button · Save
changes, not referenced in your message. Show snapshot”). The popover traps focus,
starts on Close, and Escape or an outside click returns focus to the chip. It
stays mounted, inert, through its exit. Disabled chips use native semantics and
close any open popover.

## Motion

Chips arrive like mentions (4px rise, 0.96 scale, `dur-slow` on `ease-glide`);
the popover opens from its anchor (`dur-base`, `ease-glide`) and leaves on
`ease-in` in `dur-fast`. Marker rings and pin fills ease on `dur-fast`. Under
reduced motion, nothing moves; states apply at once.

## Tokens

Accent / on-accent for pins, accent-soft behind prose markers, danger and
danger-soft for failures, surface / line / line-strong for chips,
surface-raised + shadow-pop for the popover, surface-sunken for the image well.
Type: caption for chip labels, mono-meta for tags and source, ui for the
popover title.

The `/element-mentions` preview stages real native snapshots through `stage()`
and covers empty, two pins, hover association, popover, uploading, failure,
unreferenced, disabled, narrow `@` menu, removal and sent read-only states.
`scripts/desktop-capture/scenarios/element-mentions.mjs` is its regression capture.
