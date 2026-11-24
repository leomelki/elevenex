# Conversation components

These standalone OnPush components consume renderer view models and emit typed intents. Import public components and types from `./index`. They never call the preload bridge, agents, filesystems, clipboard, or network services. Data wiring belongs to a feature container.

## Composition and ownership

- `ChatComponent` composes `ChatScroll`, user messages, turns, Markdown and turn navigation from `readonly ChatExchange[]`. Project a composer with `chatComposer`, and optional decision cards with `chatContent`.
- Enable `Chat.promptEditing` for conversations that can edit saved prompts.
  Exchanges opt in with `promptEditable`, and `promptEditRequested` carries
  the stable prompt ID. `promptEditDisabledReason` keeps the action visible
  with an explanation while the conversation is busy. On a focused user
  message, E opens the editor through the same intent as the pencil.
- `ChatExchange.mentions` supplies read-only context chips inside the corresponding user message. These reuse the composer mention appearance, retain stable IDs and full labels, and expose no removal controls in history. The owner supplies these for optimistic and restored messages; snapshot contents and transcript paths never belong in this view model.
- `TurnComponent` owns the work disclosure and composes one chronological `WorkTimeline`. Running tools, results and commentary retain their mounted identity as the latest reply changes. Each message closes the preceding activity section into an in-place summary. A recent call that was still running updates visibly when its receipt arrives, until newer work fills the visible window or another message arrives. Completed turns hide activity and earlier messages behind Worked, leaving the reply visible. Expanding Worked reveals messages and section summaries without opening their tool disclosures. Inspected or explicitly expanded work stays open. Work and outcomes stay controlled inputs. Each `WorkStep.id`, exchange ID, queue ID and mention ID must remain stable across updates. Append updates instead of rebuilding transcript identities.
- Supply `ChatExchange.deferredWork` when saved counts are available ahead of the work
  steps. `Chat` forwards `turnWorkToggled`, `turnWorkHint`, `turnWorkHintEnded` and
  `turnWorkRequested` with the turn identity. Intent is tiered: the hint starts
  after 220 ms of mouse hover over the assistant turn or visible keyboard focus
  on Worked, after 60 ms of hover on Worked itself, and immediately on a mouse,
  pen or Enter/Space press so the read overlaps the click. A touch press, which
  can begin a scroll, does not hint. One hint spans an escalating dwell; it
  ends when intent leaves or the turn expands. The open intent carries the
  IDs of previously visible expanded tools. The owner supplies pending, ready
  or error state and publishes the chronological steps together. Activity
  rejected for size shows a status message in the disclosure. A read still
  busy after 120 ms pulses the Worked heading in place (a static
  dim with reduced motion); faster reads never show it. Preserve `answerId` and set
  `answerBeforeStepId` when evidence follows the answer. Worked keeps keyboard
  focus and leaves the reply and file chips available while the activity loads.
  `filesTotal` and `filesDiff` preserve complete work facts with a bounded file
  preview. Loaded and deferred turns share the same heading and fact priority.
- `ChatExchange.harness`, `Turn.harness` and agent `Message.harness` accept an exact harness ID for the shared bundled `AgentMark` logo. Keep `author` as the accessible name/tooltip and `mark` as the monogram fallback for missing or unknown harnesses. Both render through the internal `ReplyMark` (`turns/reply-mark.component.ts`): a 28px tinted tile (peach for Claude, periwinkle with a gradient glyph for Codex, neutral for OpenCode/Pi and monograms), exposed as `role="img"` named by `author`. Supply the harness display name as `author`. The turn owns the tile's entry and live ring animations.
- `WorkTimeline` groups tool activity between messages using flat, keyed rows, so grouping never reparents a tool. Each completed section has its own expandable activity summary. The active section retains the latest five steps and summarizes older work as soon as one completed step falls outside that window. Summaries use category icons with short counts and an explicit failure marker. Failed calls fold into the section; running/unknown tools, commentary and inspected work stay visible while the turn is live or Worked is expanded. It never infers that an unrelated later success fixed an earlier failure; set `recovered` explicitly.
  An open section stays open when an older page extends it. `Chat` sets `Turn.keepWorkOnCompletion` for the turn being read away from the end, so finishing that turn leaves its activity open until the reader closes Worked.
  Focusing a link, code control or other content in the latest reply leaves Worked as it is. If a new reply turns that focused block into commentary, the timeline keeps it visible until focus leaves.
- `ComposerComponent` owns the draft (`[(draft)]` is optional), mention query, local overlay state and file-drop feedback. It emits `ComposerSubmission` with `send`, `queue` or `steer`. Queue mutations, context additions/removals, recording and all agent settings are controlled by the owner. File attachment outputs contain user-selected browser `File` objects, which the integration must resolve through the permitted platform boundary.
- Composer input content stays aligned to the top of its `AutoHeight` wrapper so text follows the animated edge during multiline growth, shrinkage and interrupted edits. The textarea owns native scrolling once its height cap is reached.
- `QueuedMessage.renderId` optionally preserves an optimistic queue row through its saved receipt. Keep that key stable while the row remains present; `id` remains the durable identity emitted by queue actions. Replacing the mounted key would retain the outgoing row during its exit and briefly inflate the composer's measured height.
- Set `QueuedMessage.steerable` and `removable` to false while a queue entry awaits its saved ID. A dispatched row leaves through the existing queue animation and releases keyboard focus to the composer in the connected view.
- Session drops emit the same `mentionInserted` intent as the @ picker. Supply `sessionMentionScope` for connected references, bounded `mentionItems` for keyboard discovery and controlled `context`; handle `contextRemoved` in the owner. Session references live only in their controlled context chips. Drops preserve the draft and its selection; choosing a session from the @ picker consumes the active query without inserting a text copy. Both restore editor focus and never submit or navigate. Removing the chip removes the session reference; ordinary message text stays independent. Duplicate session IDs and more than eight references are refused. Disabled/sending states reject drops. Cancellation/exit releases the indicator; drop transitions and chip entry respect reduced motion. Long chip labels truncate while retaining their full accessible removal name.
- `AgentPicker.openPicker()` opens from a feature-owned action; `closePicker()` synchronously restores its opener before handing off to a modal such as PresetCreator.
- `AgentPicker` consumes supported harness/model/thinking capabilities, never inventing provider options. A session locks its harness by default. Unsupported thinking levels remain disabled.
- `AgentConfig.modelLabel` can supply the closed picker's authoritative display
  label independently of its live menu catalog, so later model discovery does
  not resize the composer toolbar. Without it the picker resolves the catalog
  label, then the configured model ID as before.
- `Composer` and `AgentPicker` accept `modelsRefreshAvailable` and `modelsError`, and emit `modelsRefreshRequested`. The owner supplies catalog loading through `settingsBusy` / `busy`, performs the scoped read, and retains authoritative choices during refresh. The menu owns no transport; refresh stays inside the open surface and preserves its focus.
- `QuestionCard` owns unfinished answers and navigation. Listed single choices answer immediately; multiple questions emit one answer map only when complete. Custom answers remain selected as they are edited. Pass `answers` to render a resolved result. `ApprovalCard` remains controlled and emits the exact resolution intent.
- `Chat.centerComposer` centers its existing composer region for an empty session, preserving the composer instance, draft and focus when the first turn starts. Keep it false when decisions or history need to be visible.
- `PresetPicker` accepts stable optional `AgentConfig.id` identities, display-only `modelLabel`/`harnessLabel`, controlled `value`, `disabled` and `compact`. `AgentConfig.default` adds a quiet Default label, independently of the selected ring. Without IDs it retains name/model selection compatibility. Option+1–9 uses physical digit keys so macOS Option characters work; selection stays within the supplied window. The owner supplies at most six starting choices. The grid retains its card columns with one choice or an incomplete last row; selected Custom uses the same raised accent ring as saved choices. Hover preserves selection, and keyboard focus remains visible on both selected and dashed choices. New cards enter after first paint, and the grid height eases through the shared AutoHeight owner.
  With `adaptive`, supply the ordered catalog of up to 24 saved presets.
  The first six entries take the full tiles and numeric shortcuts. Custom
  follows the saved presets and the slim preview size follows the available
  width. Set `editing` to expose all saved tiles, with visible grips and pencils.
  Remove badges appear on full cards and on hover or focus for slim cards.
  The card itself opens the editor in this mode. Drag its grip or use
  Option+Arrow keys to reorder. Supply `editedPreset` with the saved ID and
  current display values to mark a preset adjusted for this chat. Handle
  `editRequested`, `moved`, and `removed` in the owner. Reordering uses stable
  preset IDs and FLIP across both tile sizes.
- `PresetCreator` is a retained modal draft: provide a fixed `initial` agent and current `harnesses`, saved `names`, `open`, `busy`, `blocked`, `error` and thinking/fast capabilities. `defaultAvailable` adds a “Default for new chats” setting with Keep current / Use this preset choices; `initial.default` seeds Use this preset (otherwise Keep current); `submitted.default` requests the persisted default. In edit mode the preset that is already the default cannot choose Keep current, and the owner makes another preset the default only after its edit saved. It emits `submitted(AgentConfig)` with a trimmed `preset` name, `closeRequested` and `closed`. With `harnessLocked=false` and a `catalogProvider(harnessId, signal, refresh?)`, the form offers the composer menu's harness rail and loads scoped, session-independent model capabilities on demand. Switching preserves a local draft per harness; failed reads are retryable from the menu's Try again, and closing/superseding a read aborts it and discards late results. Model choices and Create stay disabled until the chosen catalog is ready; the rail stays usable. The form edits harness/model/thinking/fast locally, checks duplicate names; it never saves on its own. Retain it through exit, deactivate children as closing begins and create a fresh identity for each draft. `ModalLayer` owns focus and recession; AutoHeight owns size changes from errors, options and harnesses with more or fewer models.
  The dialog is the composer's agent popover at dialog scale: the same surface,
  inset and `AgentMenu`. Its name field (`.identity`, initial focus) is laid out
  like the composer chip the preset becomes: the harness mark over the rail's
  column, the name, then `model · thinking` and a fast bolt, updating as the
  draft changes. A new harness's mark springs in and the summary and the submit
  label (Create preset / Save changes / Saving…) swap through `EaseSwap`. Rows
  enter 24ms apart with the dialog, all within `dur-slow`; reduced motion
  removes every movement.
  Edit mode seeds the name and settings from `initial`. Exclude the edited
  record from `names`. Optional `chatSettings` adds a This chat row that copies
  that mix into the draft and reads In use once the draft matches it.
- `SessionStart` selects the provided or first preset, offers task/branch rename intents, and accepts a projected composer. Workspace preparation never disables typing by itself. Readiness and deferred first-message delivery belong to the future session controller.
- `SideThread` is reusable panel content. When hosted in an overlay, set `trapFocus` to true and own dismissal through `closed`; the CDK restores focus to its originating element. The host owns popover placement. Promote is an intent, never a hidden fork operation.
- `JobBriefComponent` renders the supplied opening brief of a git-helper session. Inputs are `title`, `time`, and `id`; project the brief as text with inline `code`. It never inserts messages in sessions or starts a helper. The owner supplies what happened, what judgement is needed, and when to stop.

`ToolStep.detailTruncation` defaults to `"end"`. `WorkTimeline` uses `"start"`
for read tools so long paths retain their filename and trailing folders. The
full detail remains in the text and hover title; truncation follows the
available row width.

Supply `WorkStep.deferredTool` for a tool with an addressable body and pass an
`inspectTool` provider to Chat, Turn or WorkTimeline. ToolStep acquires the
provider only while the row is visible and expanded, and aborts that observation
on collapse, replacement or destruction. The feature owner handles transport and
caching. A provider may also expose `prefetch(source)`: ToolStep calls it for a
closed row after a 100 ms mouse hover or visible focus on its heading, or
immediately on a non-touch press. The owner bounds the concurrent warm-ups,
evicts the oldest beyond that bound and lets the later observation join them; plain provider functions omit it.
ToolStep keeps the heading in place until the evidence or a retry
action is ready, pulsing it only when the read outlasts 120 ms. Fold owns opening and closing, and one AutoHeight wrapper
owns updates to the already open body. Inline evidence uses the same disclosure.
Supply `WorkStep.images` with transcript addresses and pass a `toolImages`
provider to Chat, Turn or WorkTimeline for a viewed image. The tool disclosure
requests a compact preview when opened and releases it after the fold closes.
Activating the preview opens the full-size viewer.

## Scrolling and performance

`ChatLoading` lays out two placeholder exchanges above a pinned composer.
Keep it mounted for the selected view so its live status is present before its
text changes. Set `pending` only for a cold open. Both the placeholders and
the status text appear after 150 ms. Layer it over the ready chat and set
`--chat-loading-exit-duration` on successful hydration. Its surface fades out
in place, revealing the already positioned transcript and a matching composer
frame. Input reaches the ready chat during the fade. Reduced motion keeps the
placeholders static and swaps them immediately. A new view identity restarts
the delay.

Background history reads preserve the current viewport and surface a retry if they fail.
`Chat.initialHistoryPrefetch` / `ChatScroll.initialHistoryPrefetch` retain the
existing default of filling an underfull viewport. The connected session owner
enables this with default progressive loading. The window-mode override waits
for scroll intent. Other owners, including the agent inspector, keep their own
prefetch behavior. The budget and no-height-growth guard prevent hidden-work drains.

`TurnNav` shows the right-edge message selector from the first turn, regardless
of session length. Empty sessions have no navigation targets and hide it.
The rail is a small scrollable window: at most nine 24px targets, further capped
at 40% of the chat height. CDK virtual scrolling keeps only a small buffered set
of markers mounted, even with thousands of supplied turns. Faded edges indicate
more history; hovering or focusing reveals a position count and scrollbar, and
marker tooltips include the prompt, ordinal and status. It follows the current
message when idle, but holds its position during pointer/keyboard browsing.
Changing the history window releases that hold. Arrow keys, Page Up/Down and
Home/End browse without moving the chat; Enter/Space selects. There is one Tab
stop, with focus retained on the viewport while virtual rows change. Resize and
range subscriptions are released with the rail. The `/conversation` preview has
1/9/1,000/10,000-message controls for this behavior.

`ChatScroll` follows growth only while at the bottom, retains browser scroll anchoring while reading history, and shows a way back down. User messages expose `data-user-message` through `messageId`. The scroll owner finds the current prompt with a binary search, coalesces observations into animation frames, and refreshes its prompt index only when message elements change. Resize/mutation observers, scheduled frames and highlight animations are cleaned up on destruction. All message content remains readable in full; the reminder is the only clamped copy.

End following also reconciles viewport-only height changes, including composer
growth, without marking existing messages unread. A late scroll event from the
previous bottom position or a transient restoration of that offset preserves
following while layout settles. The connected session owner mounts history and
configured controls together after its first page. A cached settled window
renders and positions immediately while refreshing. A different
session gets fresh scroll/disclosure ownership; same-session refresh and verified
same-machine recovery retain the mounted view and reading position. Local session
creation keeps its immediate editable welcome through the durable receipt.
Reply and commentary wrappers contain Markdown's block margins inside the
AutoHeight observation. In particular, a trailing image's margin remains part of
the measured reply height, avoiding a shrink-and-snap on initial observation.
Automatic older-page prefetch retains end following for short tails, including
when an older prompt replaces the first partial turn. A reader scrolling during
that request keeps ownership of their reading position.

The contextual reminder is a centered glass capsule sized to its prompt, echoing
the title island: an ↑ in an accent well and the prompt on one ellipsized line.
The whole capsule is one control that scrolls back to the message and rings it.
Between exchanges its width eases to the new prompt's.

Peek: resting a mouse on a clipped prompt charges the capsule for the 320ms wait
(it swells to 102.5%, its border warms toward the accent and the ↑ well fills),
then releases it: the box springs open to up to three lines (`dur-deliberate`,
`ease-spring`) while the swell springs back and the well returns to its tint, so
the open capsule never resembles the composer's Send button. The well is inset
equally from the top and left, concentric with the capsule's corner at any
height, and centered on the first line. Leaving early drains the charge on
the same spring; leaving after it opened settles back on `ease-out`. Keyboard
focus opens it at once (`aria-expanded` follows). Touch never peeks, and a prompt
that already fits never charges, so nothing promises an opening that won't come.
The component owns the width/height morph rather than `AutoHeight`, so a swap and
a peek share one interruptible animation.

A short scrim behind it fades the reply underneath. It follows the legacy chat's
reading probe, 28% down the viewport (clamped to 48–160px): context stays
available while the next prompt is near the bottom, then clears as that prompt
enters the upper reading area.
The source prompt must be fully above a 12%-of-height reading buffer (clamped to
48–96px); the return threshold relaxes by 24px to avoid boundary flicker. This
prevents a barely clipped prompt from immediately being repeated. Viewports
below 240px suppress it. Background history reads and failures retain the available reminder; their status
sits at the lower left, clear of the reminder and return control. Removing a focused
reminder hands focus to the transcript.

Motion: on first paint the reminder is simply there. Later it un-blurs and
springs in from 88% scale (`dur-glide`, `ease-spring`) and leaves on `ease-in`
at `dur-fast`. Angular tracks the aside's own animation, so it always carries the
longest one. Jumping straight into another exchange keeps the reminder and blurs
the new prompt in over the old one. Under reduced motion no motion classes are applied and changes are immediate.

Connected owners supply `historyBefore`, `historyAfter`, `historyLoading`,
`historyError` and `historyRevision` through `Chat`/`ChatScroll`. Edge proximity
emits `historyRequested` with a `before` or `following` direction and a
`prefetch` or `reader` source. The owner merges a bounded page, gives reader
requests priority at the requested edge, and increments `historyRevision` in
the same update. Initial prefetch can fill spare room while keeping the latest
records available.
Rows expose stable `data-chat-anchor` identities so the first visible row retains
its offset after either operation. Within a long turn, `data-chat-row` identifies
individual timeline rows so prepending work preserves the answer's offset as well.
The scroll owner records several visible rows so a neighboring row can preserve
the reader's position if the first folds or leaves the window.
For a large range change, the viewport carries its previous scroll extent into
the first paint and reconciles the native scrollbar in small steps. The range
and scroll origin change together so the anchored text stays still. Wheel input
within the overlapping scroll ranges can continue while the range settles.
Input that reaches beyond a temporary edge uses the final range immediately.
With reduced motion the viewport applies the final extent and anchored position
in one paint.
The transcript remains bounded.
If the reader reverses direction, moves well away from the requested edge, or
opens visible work during a pending read, `historyCancelled` lets the owner
discard the read before it can evict the content now in view. Worked, activity
summaries and tool evidence keep their visible controls at the same offset as
their contents expand or settle.
One in-flight request and a four-page automatic fill budget bound underfilled
viewports; a page adding no visible height stops that fill immediately. Wheel
and keyboard direction choose the edge, including when both edges fit on screen.
Overflowing conversations prefetch once per gesture, and a pinned,
overflowing tail does not prefetch older pages. This avoids draining collapsed
work and evicting the reply still in view. Scroll gestures renew the budget.
History failures retain readable content and offer a
focused Retry. `latestRequested` lets the owner reconcile an evicted live tail
before moving to the bottom. No history navigation buttons are needed.

`ChatScroll.scrollToEnd(behavior)` defaults to smooth scrolling and accepts
`"instant"` for opening history before paint. Reduced motion always jumps directly.
The connected session owner jumps once after each selected session has loaded;
subsequent updates preserve the reader's position when they scroll up.
The floating arrow-only return control appears whenever the reader is more than
40px from the end, even without incoming content. Growth adds a small unread dot;
the tooltip and accessible label describe its action. It stays present during
native smooth scrolling, becomes inert
as it fades out at the end, and hands keyboard focus to the transcript on
activation. Its reversible opacity/transform transitions use the
shared motion tokens; reduced motion settles immediately. Observing both the
content and viewport also reconciles the control after layout changes.

## Markdown and security

Markdown becomes a typed AST rendered as text nodes and semantic Angular templates. Raw HTML is always inert text. Active link schemes and credential-bearing URLs are rejected. File and web links emit separate intents; copying code emits `copyCode`. Mermaid fences remain code until a future trusted diagram adapter is supplied.

Raster previews fill their available width with a height derived from 16:9 and
capped at 380px (148px in compact attachment cards) through missing, loading,
ready and error states. Natural image dimensions
belong to the full-size viewer; decoding a tall image never expands the transcript.
Gallery grid/strip and Before/After comparison geometry come from the embed list
and captions before sources arrive. Resolved recordings and pages use regular
gallery slots, including when their captions say Before and After. Slots stay keyed by path; partial failures
retain their place, comparison controls remain disabled until both images are
ready, and a gallery selection survives other images completing out of order.
Grouped images retain previous/next keyboard navigation. Recordings reserve their
preview and control row while loading or unavailable; `MarkdownRecording.loading`
and `error` describe asynchronous resolver state. Playback, seek, speed,
full-screen and timestamped steps remain available when ready, without autoplay. Assets are provided by a synchronous confined resolver, without platform calls from presentational components. `safeMediaSource` admits root-relative/app assets and supported raster data URLs; it rejects external resources, SVG data URLs and active schemes.

`WorkTimeline` renders ordered `WorkStep.media` through the same
media component. A paired tool result can use a `media` step to retain its
chronological position while the call owns the text result. Viewed images use
the corresponding tool disclosure. Standalone preview rows follow
both work and activity disclosures. Closing a row makes its media controls
inert. Its `active` binding deactivates the image viewer and recording, including
media embedded in Markdown commentary.

The production desktop forbids frame embedding and remote media. HTML documents therefore show a named page card and emit `openPage` for the Browser feature. `srcdoc` is never mounted or trusted. A future isolated page-preview adapter must preserve that desktop security boundary; the component does not weaken CSP or expose sandbox escape capabilities. Code highlighting is a text-only display lexer for JavaScript/TypeScript using the shared code palette. Code copy feedback is controlled through `copiedCode`, after the owner has handled the copy intent. Live page execution remains behind the future Browser adapter.

## Motion and accessibility

Components use the supplied design tokens, native controls, CDK overlays/focus traps and shared folds/height motion. Existing history renders without entry motion; `Message.isNew` explicitly opts a newly sent message into arrival motion. `StreamText` preserves existing chunks and animates only appended live content. Respect reduced motion throughout. Keyboard shortcuts are scoped to the composer, focused message, decision card or preset picker; there are no document-level listeners.

Opening a side panel or resizing the window rewraps existing replies and the
composer without starting content-growth animations. AutoHeight treats the new
width as a layout baseline, avoiding repeated height animations across the loaded
history. Actual content growth at a stable width retains its existing motion.
`panel-reflow.mjs` exercises longer history, draft/focus retention, interrupted
panel toggles, both themes and reduced motion through the connected preview.

`ComposerSubmission.sendOrigin` is an optional, ephemeral `MessageSendOrigin`
(left/top text coordinates and a monotonic timestamp) for direct text sends.
Carry it to the accepted local `ChatExchange.sendOrigin`; bind it to
`Message.sendOrigin` for manually composed messages. Never persist it or send it
through the platform bridge. Queue/steer submissions have no origin; the connected
owner also omits it for attachments and session context. The bounded receipt
mapping retains it with `isNew` when acknowledgement beats the first paint;
paging and selection changes release both. Fresh origins still expire after 800ms.

`ChatScroll` remembers the last painted transcript row, skipping projected
history/decision wrappers. Set `ChatExchange.revealOnArrival` to false for
background prompts so they keep the reader's scroll position above the tail.
The component still follows their arrival when pinned to the end. A fresh local
send preserves the last painted row on the first frame,
then scrolls the real viewport over 340ms on `ease-in-out` to open space for the
message and Working. `ChatSendScroll` owns that scroll clock and temporarily
disables browser anchoring; resize/early reply growth retarget from the current
position instead of snapping or compressing a long remaining trip. It retains
follow-at-end state during reveal so the return control does not flash.

`Message.playArrival()` and `finishArrival()` are internal sequencing boundaries;
consumers should not call them. A flying copy follows its moving destination
without restarting its 380ms clock, including composer shrink and reply growth.
Wheel, pointer and viewport scroll keys cancel the owned reveal/flight and keep
the reader's current position; explicit navigation and destruction release both.
Reduced motion reveals directly and keeps only the existing opacity fades.
`Message.isNew` is read once on mount: a fresh origin (under 800ms) flies an inert,
aria-hidden bubble copy for 380ms on `ease-glide`, with fill/shadow settling as it
lands. Above 160px or without an origin it rises 14px for 340ms; reduced motion
fades for 160ms. History stays still. The mounted message owns cancellation and
copy removal, including navigation during flight. Composer owns its 86% press,
4px arrow nudge and placeholder delay; existing AutoHeight returns long drafts'
space. Typing remains available during all motion.

`Turn.isNew` is also read once on mount. `Chat` supplies the exchange's fresh
flag so the new Working section follows its bubble: an 80ms lead-in, then a
340ms, 12px glide/fade on `ease-glide`, with the small agent mark settling from
86% on `ease-spring`. Its final layout space is reserved immediately, keeping
the bubble's destination steady within the transcript as the viewport reveals it. Receipt/streaming updates keep the same entry
clock; completion uses the existing work fold. History remains still. Reduced
motion uses a 160ms fade without delay or movement; keyboard focus settles entry
immediately so Stop and disclosures stay available. Native CSS animation lifetime
follows the mounted turn, including removal during entry.

`/conversation` starts with an idle composer for live send previews and provides
Run agent / Finish agent controls to try queueing. Sent turns retain Working so
the paired entrance can be inspected. The production path is exercised by
`scripts/desktop-capture/scenarios/message-send.mjs`, `message-working.mjs` and
`message-bottom-scroll.mjs` under the same scenarios directory. The last starts
from a full history window and measures natural frames from before submission.

## Connected adapter and capability controls

The shared agent settings render only the selected model's advertised thinking
levels, preserving their IDs and catalog progression. There are no placeholder
Off/Max choices for models that do not support them. Missing or empty metadata
hides the thinking row. Live settings and the preset creator use the same control;
busy/loading states disable every advertised choice.

The production [session chat adapter](../session-chat/README.md) owns transport,
selection, drafts, decisions and feedback. `Chat` accepts a `chatHistory` slot,
controlled `actions`, `stoppable`, `retryable`, and `copiedCode`. A
`ChatExchange.isNew` opts only fresh prompts into motion; `overflow` entries emit
`contentRequested` to the bounded original-content reader. Empty prompts support
partial history windows without inventing user text. `Turn` forwards the action
allowlist and retry capability, including keyboard shortcuts. The work heading
pairs a prominent verb with a muted, tabular time: `Worked for 2m 14s`,
`Stopped after 12s` or `Failed after 12s`. `duration` supplies a settled turn's
length; a live turn given `startedAt` (epoch ms) ticks `Working for …` once a
second until it settles, and otherwise shows `elapsed`. The session adapter
measures from the prompt to the turn's last activity, so a history window that
starts mid-turn has no duration. Unknown or sub-second duration shows
Worked/Working without an invented zero-second measurement. Finished turns
with no activity or earlier commentary omit the work header so the answer appears directly; live turns retain their status and
Stop control before the first step.
Turn spacing lives inside each folding section so closed work and live-step
sections leave no extra gaps between the work header and answer.
The work heading uses a retained Fold: a reply that finishes without steps fades
and collapses its last Working heading instead of removing it in one frame.
Closing controls become inert immediately, focus returns to the turn only when
it was inside the heading, and reopening reverses the same fold. Reduced motion
settles immediately; opening existing history never animates.
`ChatExchange.renderId` optionally preserves a turn's mounted identity while a
temporary prompt becomes a durable receipt. The canonical `id` still drives
navigation, copy, changes review and other intents.

`Composer.clearOnSubmit=false` lets a controlled owner clear the draft only after
accepting an intent, avoiding a child reset overtaking failure recovery.
Use `writeDraft(text)` to reflect immediate consumption or restoration in the
editor when both can occur before the next Angular render.
`Composer.sending` disables submission/queue operations while keeping the draft
editable; `stoppable` controls stop availability. `showSettings`, `showTools`,
`showDictation` and `mentionsEnabled` default to true for existing consumers.
The `composerSettings` slot accepts integration-owned capability controls.
`queueEditable`/`queueReorderable` hide unsupported queue mutations.
`ComposerQueue` exposes the corresponding `editable`, `reorderable` and
`disabled` inputs. `ApprovalCard.disabled` guards decisions and shortcuts;
`allowAlways=false` omits unsupported permanent approval. `QuestionCard.disabled`
blocks submissions and disables its native answer fieldset while a reply is pending.

`ChatExchange.streaming` can control the reply cursor independently of a turn's
live tool activity; omitted values retain the status-based default for existing
consumers. Markdown gives the cursor to the current unfinished code block or to
prose, including nested lists/quotes. `NowLine` shows only its status row until
nonblank reasoning arrives, and its preview ends at the last nonblank character.
`NowLine.streaming=false` keeps a held thinking line visible without keeping
its cursor alive during the handoff to assistant text.

`ChatExchange.answerBeforeStepId` (also accepted by `Turn`) places the latest
reply before that work step; omission means all work precedes it. Supply
`answerId` with the assistant message's stable identity. The connected `Chat`
passes `answer`, `streaming`, `copiedCode` and `resolve` to the same Markdown
instance as earlier commentary. File/link/page/copy intents work in both places.
`Turn` still supports projected answer content for existing standalone callers.

The timeline keys mounted steps by ID and retains their component instances. Nonempty
messages delimit activity sections; empty streaming replies do not close work.
A new message or completion folds settled work in the preceding section into a
summary at that location (“5 reads · 3 commands · 2 edits”), with a shared icon
for each category. Counts
represent observed operations; shell commands never imply file reads or edits.
Completed failed calls fold into the same summary. A red status glyph and text
(“1 failed”) remain visible in its button, including for a failure-only section.
Failure counts are a subset of category totals; totals count attempts, not
successes. Expected/recovered failures do not contribute to the failure marker;
later success alone never clears it. Running/unknown tools remain visible.
Each section opens independently and retains that choice through streaming and
completion. The work line shows status and time and toggles the whole timeline.
When a result adds a fact that wraps the summary, its height changes on the same
curve as the tool row folding into it. Reduced motion applies both heights at once.
Settled turns also reveal up to four work facts beside the duration on turn
hover, keyboard focus or expansion (for example, Edited 2 files · 3 commands).
When a worktree capture overlaps another turn, `ChatExchange.sharedChanges`
carries that attribution to the Worked header as workspace changes.
They enter with a short stagger and spring, and fade/slide out together on a
shorter curve; reduced motion removes movement and touch keeps them visible.
Unrecovered failure facts stay visible. Narrow headings wrap larger fact sets
while retaining the duration and disclosure. Counts cover observed calls with
unknown completion. Partial file windows show aggregate line counts when supplied.
Live counts use the shared Ticker, with still initial history and reduced motion.
Inspected results and focused controls remain mounted and visible.
Explicit section collapse releases its inspection pins; focusing a summary alone
does not open it. Commentary stays visible even when the turn’s work is closed.
`maxVisible` is the active section’s recent-step count (default 5); compaction
starts as soon as a completed step falls outside that window. That
partial summary leads with “Earlier” (accessible name “Show earlier activity: …”)
so the visible recent window is not mistaken for its contents. A new
message starts a fresh budget. The first expansion of a saved group mounts its
tool rows and gives their folds the same opening transition as later expansions.
Closed folds are inert immediately and retain disclosure state through exit and
reopening. Initial history stays still. Appended rows grow before their ink
appears. When a message closes a section, the step
and its summary share one row and one `dur-slow` curve, so the row keeps its
height and the swap crossfades. Fold and AutoHeight own reversible height
transitions and reduced-motion behavior.


## Connected composer controls

`Composer` keeps one toolbar row at narrow widths using its named `composer`
container. Thinking metadata, mode labels, then permission labels yield space
while retaining their accessible names. Send and Queue share a square icon button
sized to `--control-height`. `settingsDisabled` prevents editing. `settingsBusy`
disables choices while keeping the agent popover mounted during reconciliation.
Neither locks the draft. `modeAvailable`, `agentLocked`, `showFork`,
`showSavePreset`, `reasoningAvailable`, `fastAvailable` and `canCompact` gate
operations supplied by the owner. `permissionChoices` accepts bounded,
harness-native IDs, labels and descriptions. Omission retains the design defaults.

### AgentPicker: design and ownership

The [AgentPicker specification](../../../../../docs/design-system/project/components/AgentPicker/README.md)
defines the chip and its menu (harness rail, models, thinking track, fast pill);
the [usage specification](../../../../../docs/design-system/project/components/PlanMeter/README.md)
defines the chip's meters and hover card. The `/agent-picker` preview supplies
Claude Code, Codex, Pi, OpenCode (a long, filterable list) and a harness without
a logo, plus optional context/plan data and busy, locked and disabled states.
Its `harnesses` signal supports catalog refresh scenarios. Once shown, model
search stays mounted for that harness until the menu closes or the harness
changes, including after the catalog shrinks or the query is cleared. Space
activates the focused model; printable text starts search. From an unset thinking
level, the first arrow/Home interaction or a click on the first step explicitly
chooses the lowest reported level without changing the setting on open.

The chip identifies the harness with its logo or monogram. Its text shows the
model and optional thinking level; presets show their name with the model and
thinking level beside it. The accessible name still includes the harness.

- `AgentPicker` owns the chip, 400ms pointer/focus disclosure, CDK portals,
  positioning, focus trapping/restoration and their lifetimes. It preserves
  `open` and `openPicker()` for the composer shortcut. Its menu portal stays
  mounted through exit, immediately becomes inert and releases its backdrop's
  pointer handling. Reopening interrupts that exit. Focus starts on the chosen
  model (on the menu heading while busy) and returns to the opener on close.
  Opening the menu consumes the current usage hover/focus; restored focus does
  not reopen usage until a fresh hover or focus interaction. The menu is 340px
  with the harness rail and 296px without, and eases its height (`AutoHeight`)
  when a section comes or goes.
- Internal `AgentMenu` owns capability-derived choices, keyboard behavior and
  controlled config intents. Harness, model, thinking and fast-mode changes keep
  the menu open. The rail is a radio group (arrows move and choose) whose thumb
  is the shared `FittedHighlight`; it shows only while the harness is unlocked.
  The model list is a listbox: arrows move focus only, ↵/click chooses, typing
  jumps by first letter, and lists over eight models get a filter whose first
  Escape clears it. While `busy`, rail and model rows stay focusable with
  `aria-disabled` so keyboard position survives the update; the track, fast pill
  and actions are disabled. `disabled` disables everything. A compaction intent
  focuses the heading before its button can disappear. `modelsLoading` shows
  skeleton rows and “Loading models…” and holds model, thinking and fast choices
  like `busy`, while the rail stays usable so a slow read can be abandoned.
  `lockedHint` names why a locked harness is fixed (default “fixed for this
  conversation”). With `modelsError`, the refresh action reads Try again.
  Model rows that arrive after first paint (another harness, a cleared filter)
  ink in. With the rail, the list keeps six rows of height unless the host sets
  `--agent-menu-list-height` (the preset creator uses `auto`, from three rows up
  to six, and lets its `AutoHeight` ease the change).
  `PresetCreator` composes this same menu, so harness, model, thinking and fast
  behave identically in the composer and in a preset draft.
- Internal `ThinkingSlider` is a native range over the model's own levels,
  provider IDs kept exact and ordered as reported. Dragging previews; a level is
  emitted once committed, and a rejected change returns the thumb to the actual
  level when the update settles. An absent thinking value shows “Default”
  rather than claiming the first level.
- Internal `AgentMark` renders the bundled harness logo (`agent-logos.ts`:
  Claude Code, Codex, OpenCode, Pi; MIT/published marks, attribution in the
  file), sized by `--agent-mark-size`, or the `mark` monogram for any other
  harness. Logos match exact harness IDs only. The default `plain` appearance
  inherits `currentColor` for compact picker/preset controls. `appearance="tinted"`
  provides the reply tile, theme-aware `harness-*` colours and optical logo sizing.
  Codex uses a locally scoped SVG gradient with a unique ID per instance; it is
  app-inspired, not an official coloured asset. No animation belongs to this mark.
- `agent-config.ts` holds the shared config transitions (`withHarness`,
  `withModel`, `thinkingLabel`). The menu uses them in the composer and in the
  preset creator, so a manual change always leaves the preset and a new model
  keeps a thinking level it supports.
- Internal `AgentUsage` renders the context/plan block in the read-only hover
  card; the menu shows only its one-line plan summary. Internal `AgentPlanMeter` shows the tighter account limit
  as a clock ring. `AgentConfig.tokens` is display text. Optional `plan` follows
  the supplied `{ win, week, resetWin, resetWeek, name, tier }` API: fractions are
  **remaining**, independently of the session's context fraction **used**.
  A supplied `windows` list takes precedence over that shorthand and carries
  actual provider IDs, labels, remaining fractions, optional `weekly`, `reset`
  and compact `resetShort` text. A weekly-only snapshot never invents a 5-hour
  allowance. Optional `exhausted` also reflects a provider-declared limit.
  Missing plan data is omitted. No account catalog, provider or transport reads
  originate in these components.
- Internal `PopoverPresence` retains the two portaled surfaces and their
  readonly data snapshots through their token-based exit and owns reduced-motion subscriptions/fallback timers. It
  exists because removing a CDK portal immediately would bypass child leave
  animation. The owner cancels hover timers, releases focus and lets CDK dispose
  its traps, portals and listeners on destruction. No component-family helper is
  added to the public barrel solely for this implementation.

`AgentConfig.thinking` and `AgentModel.thinking` accept provider-reported strings.
Model labels come from `AgentModel.label`. Settings emit a config intent, never a
platform operation. Fork, Save as preset and Compact emit their existing typed
intents only when enabled by the integrating owner. The connected session owner
supplies live context, token usage and provider-reported subscription limits.
`AgentUsageNotice` accepts `agent` and a session `identity`; it chooses one line
in order: exhausted plan, critical context, low plan, high context. Only the low
plan/high context lines can be dismissed; `dismissed` lets the owner restore focus.
It does not schedule prompts or change an agent's execution. Unimplemented platform actions
remain hidden there. Preview actions are local examples, outside the product graph.

The reference's content-box dimensions are translated explicitly to the renderer's
global border-box model: the standard menu is 368px overall (360px plus two 4px
insets), rows are 36px including padding, the label column is 84px, the footer is
24px, and the hover card is 288px overall. Under a constrained viewport the portal
stays confined, long choice tracks scroll horizontally, and the footer can wrap.
The original tokens remain authoritative. Menu entry uses `dur-glide/ease-glide`;
exit uses `dur-fast/ease-in`; reduced motion removes movement.

The locked CDK version treats numeric zero as an omitted pixel minimum. Popover
minimum dimensions use CSS `"0px"` strings so flexible connected positioning can
confine the source layout to a narrow viewport without a custom position engine.
Harness changes clear transient usage metadata; each harness owns its account and
context. Closing surfaces retain the prior snapshot until exit completes.


`ChatExchange.filesTotal` (and `Turn`/`OutcomeBar.filesTotal`) can carry the full
count when `files` is a bounded metadata window. Overflow uses that total;
work facts omit partial aggregate line counts. `Chat.fileReview` carries
`{ id, path }` for outcome file chips, so Changes opens the correct reply even
when several replies edit the same file. `Chat.fileLink` sends Markdown file
links and file intents from the timeline to Code. `Chat.openFile` carries the
path for both uses.


`WorkStep.presentation` accepts a readonly `ToolPresentation` with a short summary,
optional meta/notice and bounded fields, code, text, diff, patch or list blocks.
`ToolStep` and live `NowLine` render these through `ToolContentComponent`; the
legacy string output API remains supported. Optional `preview` blocks supply the
concise primary result; `previewNotice` carries an actual omitted line/item count.
Full `blocks` mount only when the native Details disclosure opens. Original data
is a second, nested disclosure. The internal `ToolBlock` renderer is shared by
those two views and keeps all content inert. `ToolContent` is also available for
approval evidence using `[presentation]` and optional `[original]`. Original text
is mounted only when its nested native disclosure opens. Closing Details releases
its full parsed and original content while retaining the short primary result. All tool data stays inert text;
these components never fetch URLs or load returned images. The supplying adapter
owns parsing and limits. Closed Fold content remains inert, and running-to-result
updates retain the tool disclosure. The `/connected-workspace` tools preview and
`session-tools.mjs` capture scenario exercise every normalized family.
Patch and replacement evidence uses compact file headers with leading path
truncation, aligned change-marker gutters and the shared inert JavaScript/TypeScript
syntax lexer. Unified file headers and hunk ranges stay neutral. Patch markers
are separate from source text, preserving indentation, literal leading signs,
blank lines and horizontal scrolling; the complete received payload remains in
Original data. Gutters stay visible while scrolling long lines sideways.
`WorkStep.status='unknown'` means no completion receipt was received: it uses a
neutral clock, stays outside activity summaries and completed-work facts, and does
not imply failure or success. Tools retain focus and disclosure through results,
new commentary and completion; removing a focused tool restores focus to the
work control. Each new tool starts with its own disclosure state.

Tool previews mount on first inspection, not for every closed tool in history.
`WorkStep.fullContent` provides optional `inputId` / `outputId` targets when the
transport shortened evidence. `ToolStep` and `ToolContent` emit a typed
`ToolContentRequest` through `WorkTimeline` → `Turn` → `Chat.toolContentRequested`.
The owner opens the bounded reader; it never fetches from these components.
Full-content actions sit beside the primary result, outside Details. Original
data is the received payload and can itself be shortened. The connected reader
switches between the original call and its paired receipt, resetting pagination
on tab changes. Missing counterparts do not create empty tabs.

Image `MarkdownAsset` values may carry `loading` or `error` for an asynchronous
owner-supplied resolver. Media shows those states without claiming that a file is
outside the workspace. Failed browser decoding also has a readable status.
Zero/unknown image dimensions omit the native width/height attributes until the
image's intrinsic dimensions are available.

Image previews retain their source and thumbnail origin through a shared
`ModalLayer` entry/exit. The viewer grows from the thumbnail and returns focus
after closing. Escape, the close control, the outer backdrop and empty canvas
all dismiss it; image and toolbar interaction stay inside.
Initial focus lands on the labelled viewer, so opening it does not summon a
control tooltip. Tab reaches Close first; deliberate control focus and hover
retain their tooltips, which disappear on blur or pointer exit.
The header shows only its title and the shared icon-only close control; the
centered zoom readout also resets to Fit, without duplicate controls or metadata.
Zoom controls and `+`/`−`/`0` support up to 300%, with pinch zoom and
drag/arrow-key/two-finger panning.
Each viewer owns its resize observer and non-passive wheel listener. Reduced
motion uses the same immediate modal boundary without movement. The Conversation
preview includes landscape, portrait and small-image examples.


### File attachments

`Composer.attachmentsEnabled` adds a dedicated file input/paperclip independent of
`showTools`. `attachments` is a readonly `ConversationAttachment[]`; removals and
retries emit IDs. `filesAttached` handles picker, drop and paste selections.
The owner supplies uploading/ready/error state and progress; unfinished uploads
block sending. Ready attachments permit an empty text submission. `ChatExchange`
accepts the same attachment view models, rendered by `AttachmentsComponent` with
the existing confined asset resolver. This component emits `removed`, `retry` and
`copyPath`; it does not read or upload files. Draft previews must be raster data
sources supplied by the trusted feature owner. The connected owner handles
limits, retention, selection changes, send failures and uncertain delivery.
`MarkdownMedia.showCaption=false` omits a repeated caption when a surrounding
attachment card already labels the media; viewer naming remains available.


Attachment cards keep filenames once, omit redundant type/ready labels, and show
size or upload progress inline. Draft chips wrap in a bounded tray; sent media
uses compact, fixed-height previews with the message text above them. File cards
fit their contents. `MarkdownMedia.compact` opts into this thumbnail presentation
without changing the full-size image viewer. Its compact video adapter passes
`MarkdownRecording.compact` and uses native playback controls; ordinary Markdown
keeps the existing recording toolbar. `MarkdownRecording.showCaption` only controls
the visible caption, independently of the video's accessible name.

## Waiting for a machine

`Composer.waitingFor` names the unreachable machine; Enter emits a queue intent
without a bubble flight. `waiting` supplies readonly `WaitingMessage[]` with
`id`, `text`, optional `kind` (`message`/`action`), `state` (`waiting`/`sending`) and per-row `editable` / `removable`
flags. `waitingAction` supplies the current recovery action label. Handle `waitingEdited`, `waitingRemoved`, `waitingEditing` and `reconnectRequested` in the
owner. Sending and backend-accepted queues are distinct supplied states.
`ComposerQueue.waitingFor` changes its local-waiting presentation and hides Steer;
ordinary accepted queues keep their original controls.

`Chat.reach` passes `{ machine, since }` to live turns. `Turn.reach` folds in the
last-connected explanation without moving the turn elsewhere. `.ex-offline` on
the window freezes live status, thinking, tool sweep and answer cursors while
leaving interactive entrance/exit motion intact. Reduced motion still uses the
existing global and component policies. The new controls do not change message
flight or coordinated message/Working scrolling.

Forward `waitingEditing` to the outbox owner to hold first dispatch while an edit
is open. Save/Cancel releases the hold; navigation cancels the local edit while
preserving the original queued request. `ComposerQueue.editingChanged` supplies
the same lifecycle for direct consumers.

## Browser element mentions

The `element/` family renders browser selections as **named mentions**. Supply
`ConversationAttachment.element` and its stable `marker`. `ElementChip` shows a
target-framed thumbnail and readable name, with no numbered badge or DOM tag.
Its `inline` input fits sent prose. Pressing it opens the existing focus-trapped
snapshot popover; Escape restores focus. Technical metadata remains in the
snapshot. `ElementProse` replaces durable markers with these interactive inline
chips and accepts the same confined `resolve` as attachments.

`Attachments.mentionedText` omits elements already mentioned inline; elements
without a prose reference and ordinary files stay in the attachment row. Pass the
sent prompt so each snapshot appears once. Standalone attachment lists retain
all cards when that input is omitted.

Composer uses a native textarea for ordinary drafts. Staging an element switches
to the internal `ElementEditor`, preserving the writing caret and focus. Element
mentions are real `ElementChip` views inside the editable writing line, with
thumbnail, name, preview and Remove; referenced elements have no duplicate context
row. If a prose reference is erased, its still-attached snapshot remains visible
below the line and can be reused through `@` or **Mention in message**. Inline
Remove deletes only that occurrence, retaining the shared snapshot for other
mentions and supporting undo/redo. Explicitly removing the final occurrence or
an unreferenced snapshot deletes the attachment.

The rich editor owns its editable DOM, atomic token views, selection and a bounded
100-entry undo/redo history. Typing groups coalesce; Backspace/Delete removes a
whole mention. IME composition stays native until commit. Paste/drop admits plain
text only, with known copied names mapped back to the existing marker protocol;
pasted HTML never creates DOM or controls. Upload/config updates retain text nodes,
focused chip controls and popovers. A replacement draft resets undo and cancels
unfinished composition. The composer stays in rich mode after its last element
is removed so editing focus remains stable. It emits the same canonical `draft`
and submissions as before; queue previews/editors retain readable names.

Integrating owners should call `Composer.focusEditor()` to focus either editor.
The `textarea()` query remains available for ordinary drafts only. The internal
editor handles selection in canonical marker offsets, never thumbnail-label text
lengths. Capture, upload, lifecycle and the backend protocol remain with the owner.

`elementPickAvailable` enables the `@` menu's “Point at an element in the browser”
command, which emits `elementPickRequested`.
`insertElement(marker)` inserts a named reference; `elementRepick` forwards Pick
again. Element mentions never emit `mentionInserted`. Capture, upload and browser
authority remain with the owner. Snapshot outlines stay outside target borders;
uploaded pixels and the [wire/lifetime contract](../../../../../docs/browser-element-mentions.md)
remain unchanged. The `/element-mentions` preview stages actual host snapshots.


## Captured shell results

`ToolPresentation.shell` supplies provider-neutral command facts and captured
output. `ShellToolComponent` renders it inside the existing ToolStep disclosure,
with the renderer's theme, shared icon controls, wrap/copy actions and a bounded
scroll region. This is a read-only receipt; it never starts or attaches to a PTY.
The session adapter owns provider normalization. ANSI parsing happens only after
that disclosure first mounts and is independent of live status or copy feedback.
Standard ANSI colors follow semantic theme tokens; explicit RGB/256 colors are
preserved. All output remains inert text; OSC links, clipboard escapes and other
control sequences cannot invoke platform operations.

The adapter retains at most 100,000 captured characters and 24,000 command
characters. Initially 80 tail lines are mounted; Show more lines increases that
window to at most 1,000. Copy captured output copies the normalized available
capture, including lines outside that DOM window. Source shortening is disclosed;
the existing full-input/output reader remains the path to provider-truncated
transcripts. Scrolling up retains the captured lines being read, including when newer output
would evict the tail. New output available signals pending text; Jump to latest
resumes following.
Expansion preserves distance from the bottom. Copy emits the existing code-copy
intent through the timeline to the session owner, which uses native clipboard
IPC, stale-result guards and acknowledged success/error feedback.

`preview`'s `shell-results` scenario and
`scripts/desktop-capture/scenarios/shell-tool-results.mjs` exercise these production
components in both themes, with long, failed and empty receipts, keyboard
controls, native copy feedback, wrapping and narrow reduced-motion layouts.
