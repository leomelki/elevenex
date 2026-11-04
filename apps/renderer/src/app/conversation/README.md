# Conversation components

These standalone OnPush components consume renderer view models and emit typed intents. Import public components and types from `./index`. They never call the preload bridge, agents, filesystems, clipboard, or network services. Data wiring belongs to a feature container.

## Composition and ownership

- `ChatComponent` composes `ChatScroll`, user messages, turns, Markdown and turn navigation from `readonly ChatExchange[]`. Project a composer with `chatComposer`, and optional decision cards with `chatContent`.
- `ChatExchange.mentions` supplies read-only context chips inside the corresponding user message. These reuse the composer mention appearance, retain stable IDs and full labels, and expose no removal controls in history. The owner supplies these for optimistic and restored messages; snapshot contents and transcript paths never belong in this view model.
- `TurnComponent` owns only expanded evidence and a 700ms current-step hold. Work and outcomes stay controlled inputs. Each `WorkStep.id`, exchange ID, queue ID and mention ID must remain stable across updates. Append updates instead of rebuilding transcript identities.
- `ChatExchange.harness`, `Turn.harness` and agent `Message.harness` accept an exact harness ID for the shared bundled `AgentMark` logo. Keep `author` as the accessible name/tooltip and `mark` as the monogram fallback for missing or unknown harnesses. Both render through the internal `ReplyMark` (`turns/reply-mark.component.ts`): a 28px tinted tile (peach for Claude, periwinkle with a gradient glyph for Codex, neutral for OpenCode/Pi and monograms), exposed as `role="img"` named by `author`. Supply the harness display name as `author`. The turn owns the tile's entry and live ring animations.
- `WorkTimeline` groups adjacent successful discovery steps. Failed work stays visible. It never infers that an unrelated later success fixed an earlier failure; set `recovered` explicitly.
- `ComposerComponent` owns the draft (`[(draft)]` is optional), mention query, local overlay state and file-drop feedback. It emits `ComposerSubmission` with `send`, `queue` or `steer`. Queue mutations, context additions/removals, recording and all agent settings are controlled by the owner. File attachment outputs contain user-selected browser `File` objects, which the integration must resolve through the permitted platform boundary.
- `QueuedMessage.renderId` optionally preserves an optimistic queue row through its saved receipt. Keep that key stable while the row remains present; `id` remains the durable identity emitted by queue actions. Replacing the mounted key would retain the outgoing row during its exit and briefly inflate the composer's measured height.
- Session drops emit the same `mentionInserted` intent as the @ picker. Supply `sessionMentionScope` for connected references, bounded `mentionItems` for keyboard discovery and controlled `context`; handle `contextRemoved` in the owner. Session references live only in their controlled context chips. Drops preserve the draft and its selection; choosing a session from the @ picker consumes the active query without inserting a text copy. Both restore textarea focus and never submit or navigate. Removing the chip removes the session reference; ordinary message text stays independent. Duplicate session IDs and more than eight references are refused. Disabled/sending states reject drops. Cancellation/exit releases the indicator; drop transitions and chip entry respect reduced motion. Long chip labels truncate while retaining their full accessible removal name.
- `AgentPicker.openPicker()` opens from a feature-owned action; `closePicker()` synchronously restores its opener before handing off to a modal such as PresetCreator.
- `AgentPicker` consumes supported harness/model/thinking capabilities, never inventing provider options. A session locks its harness by default. Unsupported thinking levels remain disabled.
- `QuestionCard` owns unfinished answers and navigation. Listed single choices answer immediately; multiple questions emit one answer map only when complete. Custom answers remain selected as they are edited. Pass `answers` to render a resolved result. `ApprovalCard` remains controlled and emits the exact resolution intent.
- `Chat.centerComposer` centers its existing composer region for an empty session, preserving the composer instance, draft and focus when the first turn starts. Keep it false when decisions or history need to be visible.
- `PresetPicker` accepts stable optional `AgentConfig.id` identities, display-only `modelLabel`/`harnessLabel`, controlled `value`, `disabled` and `compact`. `AgentConfig.default` adds a quiet Default label, independently of the selected ring. Without IDs it retains name/model selection compatibility. Option+1–9 uses physical digit keys so macOS Option characters work; selection stays within the supplied window. The owner supplies at most six starting choices. The grid retains its card columns with one choice or an incomplete last row; selected Custom uses the same raised accent ring as saved choices. Hover preserves selection, and keyboard focus remains visible on both selected and dashed choices. New cards enter after first paint, and the grid height eases through the shared AutoHeight owner.
- `PresetCreator` is a retained modal draft: provide a fixed `initial` agent and current `harnesses`, saved `names`, `open`, `busy`, `blocked`, `error` and thinking/fast capabilities. `defaultAvailable` adds a “Default for new chats” setting with Keep current / Use this preset choices; `initial.default` seeds Use this preset (otherwise Keep current); `submitted.default` requests the persisted default. It emits `submitted(AgentConfig)` with a trimmed `preset` name, `closeRequested` and `closed`. With `harnessLocked=false` and a `catalogProvider(harnessId, signal, refresh?)`, the form offers a Harness dropdown and loads scoped, session-independent model capabilities on demand. Switching preserves a local draft per harness; failed reads are retryable, and closing/superseding a read aborts it and discards late results. Model controls and Create stay disabled until the chosen catalog is ready. The form edits harness/model/thinking/fast locally, checks duplicate names; it never saves on its own. Retain it through exit, deactivate children as closing begins and create a fresh identity for each draft. `ModalLayer` owns focus and recession; AutoHeight owns error-driven size changes.
- `SessionStart` selects the provided or first preset, offers task/branch rename intents, and accepts a projected composer. Workspace preparation never disables typing by itself. Readiness and deferred first-message delivery belong to the future session controller.
- `SideThread` is reusable panel content. When hosted in an overlay, set `trapFocus` to true and own dismissal through `closed`; the CDK restores focus to its originating element. The host owns popover placement. Promote is an intent, never a hidden fork operation.
- `JobBriefComponent` renders the supplied opening brief of a git-helper session. Inputs are `title`, `time`, and `id`; project the brief as text with inline `code`. It never inserts messages in sessions or starts a helper. The owner supplies what happened, what judgement is needed, and when to stop.

## Scrolling and performance

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

Local raster images have reserved dimensions and a keyboard-accessible native modal viewer. Grouped images provide a picture viewer with previous/next keyboard navigation. Before/after pairs have a keyboard-accessible comparison slider. Local recordings have playback, seek, speed, full-screen and timestamped step controls, and never autoplay. Assets are provided by a synchronous confined resolver, without platform calls from presentational components. `safeMediaSource` admits root-relative/app assets and supported raster data URLs; it rejects external resources, SVG data URLs and active schemes.

The production desktop forbids frame embedding and remote media. HTML documents therefore show a named page card and emit `openPage` for the Browser feature. `srcdoc` is never mounted or trusted. A future isolated page-preview adapter must preserve that desktop security boundary; the component does not weaken CSP or expose sandbox escape capabilities. Code highlighting is a text-only display lexer for JavaScript/TypeScript using the shared code palette. Code copy feedback is controlled through `copiedCode`, after the owner has handled the copy intent. Live page execution remains behind the future Browser adapter.

## Motion and accessibility

Components use the supplied design tokens, native controls, CDK overlays/focus traps and shared folds/height motion. Existing history renders without entry motion; `Message.isNew` explicitly opts a newly sent message into arrival motion. `StreamText` preserves existing chunks and animates only appended live content. Respect reduced motion throughout. Keyboard shortcuts are scoped to the composer, focused message, decision card or preset picker; there are no document-level listeners.

`ComposerSubmission.sendOrigin` is an optional, ephemeral `MessageSendOrigin`
(left/top text coordinates and a monotonic timestamp) for direct text sends.
Carry it to the accepted local `ChatExchange.sendOrigin`; bind it to
`Message.sendOrigin` for manually composed messages. Never persist it or send it
through the platform bridge. Queue/steer submissions have no origin; the connected
owner also omits it for attachments and session context. The bounded receipt
mapping retains it with `isNew` when acknowledgement beats the first paint;
paging and selection changes release both. Fresh origins still expire after 800ms.

`ChatScroll` remembers the last painted transcript row, skipping projected
history/decision wrappers. A fresh send preserves that row on the first frame,
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
allowlist and retry capability, including keyboard shortcuts. Unknown duration
shows Worked/Working without an invented zero-second measurement. Finished turns
with no work steps (excluding commentary and system notes) omit the work header
and timeline so the answer appears directly; live turns retain their status and
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
prose, including nested lists/quotes. `NowLine.streaming=false` keeps a held
thinking line visible without keeping its cursor alive during the handoff to
assistant text.

`ChatExchange.answerBeforeStepId` (also accepted by `Turn`) places the latest
reply before that work step. Omit it when all work precedes the answer. Both
timeline sections follow the same work disclosure; individual tools retain
their output disclosures. This keeps commentary before tools that follow it,
including during streaming, while keeping the latest answer visible on collapse.
Only the last preceding running step uses `NowLine`; overlapping running tools
stay in their original timeline positions. Hover/focus facts include completed
edits, searches, listings, web requests and generic tools as well as reads and
commands, and remain available during live work.


## Connected composer controls

`Composer` keeps one toolbar row at narrow widths using its named `composer`
container. Thinking metadata, mode labels, then permission labels yield space;
accessible names remain. `settingsDisabled` prevents editing; `settingsBusy`
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
  focuses the heading before its button can disappear.
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
  `withModel`, `thinkingLabel`). The menu and the preset form's
  `AgentSettings` both use them, so a manual change always leaves the preset
  and a new model keeps a thinking level it supports.
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
`{ id, path }` for file chips and Markdown file links, so connected owners can
open the correct reply even when several replies edit the same file. The existing
`openFile` path output remains available for other consumers.


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
`WorkStep.status='unknown'` means no completion receipt was received: it uses a
neutral clock, stays outside discovery groups and completed-work facts, and does
not imply failure or success. A live tool's focus returns to the turn's work
control before replacement/completion hides it; each new tool starts with its
own disclosure state.

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
