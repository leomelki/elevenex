# ElementReference

A compact visual reference to a browser element, staged with a message or restored
with its history. It represents the page **at selection time**. The screenshot
never implies that the page, element or locator is still current.

The conversation family's Angular `ElementReferenceComponent` is canonical.
It accepts a readonly `ConversationAttachment` with `element` metadata, `editing`,
`disabled` and the existing confined `resolve` function. Outputs are `removed(id)`,
`retry(id)` and `mention()`. Capture, upload, selection ownership and delivery live
outside this component. `Attachments` composes it in both Composer and Message.

The card pairs a context thumbnail with a fine accent outline of the target,
recognizable `tag · accessible label`, stable `@element-xxxxxxxx` alias, source-hint
availability and explicit upload progress/failure. Missing source never blocks a
visual reference. No selector, geometry or technical payload occupies the normal
writing area. The outline is drawn over the preview; no visual decoration is injected into the website or encoded into image bytes. Large and clipped targets retain their original CSS
rectangle; the outline intersects the crop. The larger preview retains aspect ratio.

Use **Mention** or the existing @ menu to insert the card's stable alias at the
caret. The card is the single owner of the semantic reference and attachment;
the alias is a pointer to that reference, not an editable copy of its label or
metadata. Repeated mentions reuse the same attachment. Multiple cards have
separate identities even with identical labels. Removing a card removes its
context and image; an outstanding alias blocks sending with a repair explanation.
The preview’s Pick again in Browser intent returns to the original tab for a new human selection; closed/detached tabs explain how to choose another page. Picking again explicitly creates a new reference. Upload Retry reuses the original
pixels and reference rather than recapturing a possibly changed page.

The thumbnail is a native button. Enter/Space opens a labelled modal with the
larger image, target outline, capture time, page route, optional unverified source
hint and collapsed technical details. Escape/Close restores the opener. Retain
modal content through exit, and make closing children inert. Sent messages use
the same preview with no edit controls. History without an available image shows
an honest loading/unavailable fallback. Disabled controls use native semantics.

Use the supplied surface, accent, ink, spacing, radius and type tokens. Cards
wrap above the ordinary textarea and fit narrow conversations without consuming
the typing area. They have no independent entrance animation; Composer's existing
AutoHeight owns the tray size and ModalLayer owns preview motion/reduced motion.

The `/element-mentions` renderer preview accepts real native fixture snapshots
through its `stage(snapshot)` operation and exercises empty, multiple, uploading,
failed/retry, ready, disabled and read-only states. The reusable capture scenario
uses a newly captured native crop, not fabricated artwork.
