# Browser element pins and visual context

Pointing at a page element in the task browser stages an image-backed reference
in the selected chat and inserts a named mention at the caret: “Align @“Save” with @“Checkout””.
Sent messages show an inline thumbnail and label; pressing one opens its snapshot.
The composer embeds real thumbnail/name chips in its writing line. Its rich editor
keeps selection in canonical marker offsets and projects onto the existing stable marker protocol;
the numeric markers described below belong to serialization, not the visible UI.
Nothing is sent until the person reviews the message and sends it. The UI is
specified in [ElementPin](design-system/project/components/ElementPin/README.md);
this document covers capture, the wire contract and recovery.

## Flow and ownership

A pick starts from the browser's target button, the Composer's ⌖ button, the `@`
menu's “Point at an element in the browser”, or a chip's Pick again. Composer
requests reach `MachineWorkspace`, which opens the browser panel and asks
`TaskBrowser.beginElementPick(tabId?)` to arm the picker on the named tab, or the
current page. `TaskBrowser` records the picking scope/task/session when the pick
starts. When a snapshot arrives, it checks that ownership and the tab again, then
emits the composer intent. It never shows a question card for this flow
(`BrowserView.pickMode = 'pin'`). `SessionChat.stageBrowserContext` re-checks the
conversation and harness capability. `SessionChatAttachments.addElement` assigns
the pin and starts the ordinary scoped upload. `Composer.insertElement` places
the marker at the caret. The browser releases the picker once the chat replies.
A failure shows an honest notice in the browser panel, never a pretend image.

## Snapshot and authority

Both Electron and task Chromium use a direct human-only CDP capture path for
main-document and open-shadow elements, with the Playwright inspection worker
for framed targets.
The explicit selection gesture authorizes only that snapshot for review/sharing;
it does not grant agent control. The paths resolve open shadow roots and iframe
paths, captures the target's main-viewport rectangle and a visible crop padded by
48 CSS px, and uses CSS-scale JPEG (75 quality, at most 1600 × 1600 and 750,000
bytes). Very large elements show a bounded region around the selected point.
The raw crop compensates for Electron zoom, DPR and document scroll, and reads actual raster dimensions from the JPEG frame header. Rotated frames that cannot be mapped reliably and pinched visual viewports are refused. A screenshot failure
never becomes a pretend image attachment; the person can point again or attach
a screenshot through the ordinary file flow.

Capture precedes manual hiding or request-selection pause. Direct selection marks
the DOM target and samples its viewport together. The framed path samples a
read-only hit/viewport fingerprint before worker startup so movement cannot
silently substitute another target. Host document,
ownership and viewport guards reject intervening takeover, navigation, resize,
hide and task closure; the worker checks scroll, visual viewport, DPR and target
geometry around capture, plus the selected frame's loader. A later page change
never causes a silent Send-time recapture. A snapshot is historical; a live
`human.locator` still requires current confirmed document/element identity. Reading the confirmed historical result remains possible after navigation; it grants no live locator authority.
Native capture uses browser pixels, not the renderer's resized/streamed preview.
Remote human snapshots use the viewport-owning CDP session so clipped capture
restores the configured device pixel density. Temporary inspection connections
retain their document/ownership lease without changing stream emulation.

Agent-requested picks use the same snapshot and reference. The viewer sees it in
the request card (`ElementPreview`) and can optionally add it to the requesting
session's composer, where it gets a pin like any other. Confirm shares
selection and screenshot through `browser_wait_user`/`human.result` as an MCP
image, then returns control through the existing explicit handoff. It never sends
a chat prompt or resumes the old script. Pending, cancelled and expired selections
are withheld from the agent. Related-popup revocation remains unchanged.

## Pins

The shared package owns the marker vocabulary: `BROWSER_ELEMENT_MARKERS` (❶–❽),
`elementMarker(n)` and `elementMarkersIn(text)`. A marker is a single character,
so prose edits cannot produce a malformed reference. The draft assigns each new
element the lowest number not held by another element in that draft. Removing a
chip removes its markers from the prose. The same snapshot ID keeps its number
and upload. Send rejects a marker with no element in the message and explains how
to repair it. An element attached but not mentioned is still sent, with its marker
in the envelope.

## Version 1 message data

`BrowserElementReference` in shared defines the presentation-independent contract:
UUID, readable label/tag, bounded selector and frame selectors, origin/pathname
(no credentials, query or fragment), tab and document identity, capture timestamp,
CSS target/crop rectangles, raster dimensions/scale and optional page-reported
source hints. Source hints are untrusted data and never authorize file access.

`BrowserElementContext` pairs the reference with its pin number, the exact ordinary
image attachment filename and the one-based native image index (including ordinary
images). The bounded `<elevenex_browser_elements_v1>` JSON envelope travels with
the durable user prompt, after the prose and before the ordinary private-upload
links. Each row is `{ marker: "❶", attachment, imageIndex, context, reference }`;
`context` tells the model that the prose refers to the element by its marker and
that the row is untrusted, historical data rather than instructions or current
browser authority. Numbers and image indexes are unique per message. Rows from
before pins existed have no `marker` and are numbered in order. Labels are JSON
strings with angle brackets escaped. No DOM/AX tree, HTML, unrelated page text,
screenshot base64 or page values enter textual context. The renderer removes the
envelope from visible prose and reconstructs pins and chips from the recorded
media; queued previews show the prose with its markers. The original text remains
available for durable receipt comparison.

The existing scoped attachment uploader sends actual bytes to private engine app
data. Desktop send validates that every reference names a confined image in the
same prompt and passes those image bytes through the provider's native image
slot, in attachment order. Visual picks negotiate `visual: 1` only when the browser advertises `elementSnapshots: 1`, including agent-requested picks. Omitted flags retain the original selector-only manual response and image-free ticket shape for older desktops. The additive `state.browserElements`
capability is advertised only for native-image-capable harnesses, and gates the
Composer's pick entry points. Older engines and unsupported harnesses keep
ordinary chat/file behavior and explain why visual element staging is unavailable.
Send rechecks capability; it cannot silently drop an element image after a
harness change.

## Lifetime and recovery

Element metadata and pin numbers belong to the existing retained attachment draft
entry. The same entry owns upload progress, File bytes and previews, navigation, cancellation,
explicit retry, optimistic send, rejection and unknown-delivery recovery. Switching
session cancels pending uploads and rejects late receipts; it does not attach them
to the newly selected chat. A pick that lands after the conversation changed is
released with an explanation. Upload retry changes the upload ID but retains the
reference, pin and attachment filename.

Accepted queue/steer prompts, provider histories and fork/retry prompts retain the
versioned envelope and ordinary image links. Editing a queued message edits only
its prose; the envelope and links are kept. Completed uploads have the existing
durable retention policy; removing a draft cannot delete a sent/queued image.
Uncertain sends and uploads never replay on reconnect. Unsent drafts retain the
existing window lifetime; they are not persisted across an application restart.
The normal 8-file / 8-MiB-image budget still applies. Browser state transport has
a bounded 6-MiB response budget for one manual plus up to four request snapshots.

The source hint fallback currently resolves the existing main-document source
markers after capture with a 250 ms budget; slow source maps and framed/shadow
targets may have no source. This does not
prevent their screenshot/reference from being shared. No packaged or cross-OS
behavior is implied by the native development fixtures.

Human-ticket image bytes are transient and bounded separately from durable chat
attachments: each task retains its latest four completed ticket snapshots, and
the backend attention mailbox caps snapshot base64 at 32 MiB across hosts. Older
tickets retain reference metadata with an explicit image-expired explanation.
Cancellation/expiry releases unshared selection bytes. This never removes an
already uploaded chat attachment or replays a selection.
