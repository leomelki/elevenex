# Browser element mentions and visual context

Manual Point and ask stages an image-backed reference in the selected chat.
Nothing is sent until the person reviews it and sends their message. The browser
panel keeps the target summary; the conversation uses the reusable ElementReference
card and ordinary attachment delivery. Mention or @ inserts a stable alias, e.g.
“Align @element-abc12345 with @element-def67890”. Removing a reference cannot
silently reassign that alias to another card.

## Snapshot and authority

Both Electron and task Chromium use the human-only Playwright inspection worker.
The explicit selection gesture authorizes only that snapshot for review/sharing;
it does not grant agent control. The worker resolves open shadow roots and iframe
paths, captures the target's main-viewport rectangle and a visible crop padded by
48 CSS px, and uses CSS-scale JPEG (75 quality, at most 1600 × 1600 and 750,000
bytes). Very large elements show a bounded region around the selected point.
The raw crop compensates for Electron zoom, DPR and document scroll, and reads actual raster dimensions from the JPEG frame header. Rotated frames that cannot be mapped reliably and pinched visual viewports are refused. A screenshot failure
never becomes a pretend image attachment; the person can pick again or attach
a screenshot through the ordinary file flow.

Capture precedes manual hiding or request-selection pause. A small read-only hit/viewport fingerprint is sampled before inspection-worker startup; movement cannot silently substitute a different target during that startup. Host document,
ownership and viewport guards reject intervening takeover, navigation, resize,
hide and task closure; the worker checks scroll, visual viewport, DPR and target
geometry around capture, plus the selected frame's loader. A later page change
never causes a silent Send-time recapture. A snapshot is historical; a live
`human.locator` still requires current confirmed document/element identity. Reading the confirmed historical result remains possible after navigation; it grants no live locator authority.
Native capture uses browser pixels, not the renderer's resized/streamed preview.

Agent-requested picks use the same snapshot and reference. The viewer can inspect
it and optionally stage it in the requesting session's composer. Confirm shares
selection and screenshot through `browser_wait_user`/`human.result` as an MCP
image, then returns control through the existing explicit handoff. It never sends
a chat prompt or resumes the old script. Pending, cancelled and expired selections
are withheld from the agent. Related-popup revocation remains unchanged.

## Version 1 message data

`BrowserElementReference` in shared defines the presentation-independent contract:
UUID, readable label/tag, bounded selector and frame selectors, origin/pathname
(no credentials, query or fragment), tab and document identity, capture timestamp,
CSS target/crop rectangles, raster dimensions/scale and optional page-reported
source hints. Source hints are untrusted data and never authorize file access.
The UUID's first eight characters form the human alias, retained across retries
and history. Repeated identical snapshot IDs deduplicate before upload.

`BrowserElementContext` pairs the reference with the exact ordinary image
attachment filename and one-based native image index (including ordinary images). The bounded `<elevenex_browser_elements_v1>` JSON envelope
travels with the durable user prompt alongside ordinary private-upload links.
It states the alias, image association and historical/untrusted meaning. Labels
are JSON strings, with angle brackets escaped. No DOM/AX tree, HTML, unrelated
page text, screenshot base64 or page values enters textual context. The renderer
removes this envelope from visible prose and reconstructs the same card using
recorded media metadata. Queued display summarizes labels without showing JSON.
The original text remains available for durable receipt comparison.

The existing scoped attachment uploader sends actual bytes to private engine app
data. Desktop send validates that every reference names a confined image in the
same prompt and passes those image bytes through the provider's native image
slot, in attachment order. The filenames in prose/JSON identify each image even
when ordinary attachments are mixed in. Visual picks negotiate `visual: 1` only when the browser advertises `elementSnapshots: 1`, including agent-requested picks. Omitted flags retain the original selector-only manual response and image-free ticket shape for older desktops. The additive `state.browserElements`
capability is advertised only for native-image-capable harnesses. Older engines
and unsupported harnesses keep ordinary chat/file behavior and explain why visual
element staging is unavailable. Send rechecks capability; it cannot silently drop
an element image after a harness change.

## Lifetime and recovery

Element metadata belongs to the existing retained attachment draft entry. The
same entry owns upload progress, File bytes and previews, navigation, cancellation,
explicit retry, optimistic send, rejection and unknown-delivery recovery. Switching
session cancels pending uploads and rejects late receipts; it does not attach them
to the newly selected chat. Staging also checks the original scope/task/session,
and manual picker ownership is captured when picking starts. Upload retry changes
the upload ID but retains the stable reference and attachment filename.

Accepted queue/steer prompts, provider histories and fork/retry prompts retain the
versioned envelope and ordinary image links. Completed uploads have the existing
durable retention policy; removing a draft cannot delete a sent/queued image.
Uncertain sends and uploads never replay on reconnect. Unsent drafts retain the
existing window lifetime; they are not persisted across an application restart.
The normal 8-file / 8-MiB-image budget still applies. Browser state transport has
a bounded 6-MiB response budget for one manual plus up to four request snapshots.

The source hint fallback currently resolves the existing main-document source
markers after capture; framed/shadow targets may have no source. This does not
prevent their screenshot/reference from being shared. No packaged or cross-OS
behavior is implied by the native development fixtures.

Human-ticket image bytes are transient and bounded separately from durable chat
attachments: each task retains its latest four completed ticket snapshots, and
the backend attention mailbox caps snapshot base64 at 32 MiB across hosts. Older
tickets retain reference metadata with an explicit image-expired explanation.
Cancellation/expiry releases unshared selection bytes. This never removes an
already uploaded chat attachment or replays a selection.
