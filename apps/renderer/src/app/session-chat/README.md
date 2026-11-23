# Connected session chat

`SessionChatComponent` is the production adapter for a selected
`{ scopeId, taskId, sessionId }`. It composes the conversation family's public
components; those components remain independent of the bridge and providers.
`MachineWorkspace` provides the chat client and drafts at workspace lifetime,
so nested/preview backend scopes resolve consistently.

The pencil on a saved prompt opens an editor with the original text, the
impact on later turns, and an indication of any retained context. Escape
cancels the edit. Control or Command plus Enter resends the revision.
The current composer draft stays available throughout. Edits require a
reachable engine and an idle conversation with an empty queue. If delivery
is uncertain, the adapter refreshes the conversation and keeps the editor
text available to copy. If another turn changed the edit boundary, refreshing
the edit details updates the affected-message count and keeps the revised text.
The editor grows with the draft up to a viewport-relative limit, then scrolls
within the text field. The shared modal and height transitions preserve focus
as content arrives. The primary action stays mounted through resend and
conflict recovery, with reduced motion honored throughout.

Unseen completions use the optional `state.unseenCompletionAt` version. After
latest content renders at the end of the conversation in a focused, visible,
active window, the owner sends `mark-seen` through the existing command bridge.
Inert/hidden chat ancestors, older history and background windows keep the marker.
The component releases its focus/visibility listeners and ancestor observer on
destruction. No notification, approval or file-review action is required.
The store coalesces acknowledgments and rejects replies for an old scope,
selection or completion. Failed writes retain the marker; they never enter the
prompt outbox. Older engines omit the field and receive no new command.

The connected owner can supply a `creation: StartingSession` before a saved
`selection` exists. The same chat/composer stays mounted through confirmation;
`creationKey` retains UI identity and autofocus even if confirmation arrives before
the first paint. `SessionChatStore.openDraft` permits typing but dispatches no
reads, uploads, settings or prompts for a local draft. Confirmation adopts its
signals into `SessionChatDrafts` before opening the real session. Initial hydration
keeps the welcome visible and sending disabled. Writing that began during creation
keeps a compact welcome when settings arrive, so preset cards do not move the
composer; starting choices remain available through the agent picker. The owner
handles `creationRetry`, `creationCheck` and `creationDiscard`. Failed/unconfirmed
creates retain writing, and checking or reconnecting never replays creation.

The optional `state.sessionMentions` capability enables sidebar drops and the
@ picker. Workspace supplies at most 50 candidates from already-loaded session
windows; drag payloads retain their backend generation. The composer owns drag
feedback, query consumption and focus. Session references have a single chip-only
representation and never add an editable @title copy. The store owns deduplicated context (up to
eight sessions), retained drafts and delivery recovery. Mentions clear with an
accepted send and return to their original draft after rejection/uncertainty,
including when navigation overtakes the reply. Send carries optional numeric
`sessionIds`; main and backend validate the bound. The backend resolves those
identities through its existing conversation exporter only on explicit send,
adds at most 4,000 snapshot characters per reference and retains the full export
for agent lookup. Unresolvable references prevent submission. Ordinary message
and queue projections omit snapshot blocks, preserving receipt reconciliation.
User transcript items also carry up to eight `mentions` with only a session ID
and title, recovered from saved snapshot headers. Main validates these optional
fields and strips extras. The store includes them in optimistic prompts; both
pending and saved references become read-only chips inside the sent message.
History reload reconstructs them without re-exporting referenced sessions.
Older engines omit the capability and retain their original send contract.

- `SessionChatClient` calls only named, scope-bound bridge operations. Main owns
  HTTP, credentials, validation, coalescing, deadlines and cancellation.
- `SessionChatStore` owns one visible transcript window, its live cursor,
  mutation epochs and feedback. It releases the stream on navigation, hiding
  or destruction. Main keeps the stream open between updates and resumes from
  the last applied cursor after an interruption. Pending writes can finish on
  their original backend, and their replies apply only to their original
  conversation. Reconnect and refresh issue reads only.
  Heartbeats stay in main. Live updates retain unchanged conversation inputs.
  Backend resets reconcile the authoritative suffix, including rewinds while
  a session was cached. An overlapping first row lets both background resets
  and explicit refreshes retain the loaded prefix when the prompt context
  still matches. Rows repeated in the suffix use its authoritative positions.
  A page read across a rewrite reopens the new tail. Interruptions retain the
  transcript, scroll position and draft.
  The reconnect message appears after a short delay. Confirmed non-configuration
  actions reconcile through the open stream.
- Adjacent history reads pause the watch and resume it when the page arrives.
  Live updates refresh runtime state while the user reads a historical window.
  The engine's optional `state.activePromptId` identifies the foreground turn
  independently of paging. A visible slice of that turn keeps Working and its
  open work timeline while the retained transcript waits for a return to latest.
  Older engines omit the prompt ID and use the latest visible turn when following live.
  A forward page that reaches latest establishes a fresh live snapshot before
  incremental reading resumes. Returning to latest keeps the
  historical window and its cursors until the fresh snapshot succeeds.
  Older engines without `chatStream` use bounded long reads and the same history controls.
- Paging keeps at most 320 contiguous raw records. When hidden work leaves the
  newer edge, `session-chat-tail` retains compact prompt/reply, media and outcome
  context for up to 16 nearest turns, 80 records and 256,000 text/input characters.
  Source message boundaries keep a progress update from merging into the answer
  and changing its mounted identity. Context never supplies pagination or delivery
  cursors; following pages consume it without duplicate replies. Explicit history
  replacement and session navigation release it. This keeps short collapsed turns
  readable without retaining every tool record or fetching the full transcript.
- `SessionChatDrafts` keeps a 20-entry cache of live composers per workspace.
  It reads unsent text on demand from the local app, keyed by saved window,
  configured machine, task and session. Edits reach main independently of
  backend availability, and a restart restores the text when that composer
  opens. Attachments and mention chips have a window lifetime.
  Entries with unsaved changes or unresolved writes stay in memory. A failed
  send restores its text ahead of any newly typed draft. Accepted sends remove
  their submitted text and keep later edits. If the app closes during a send,
  reopening preserves the text and asks the user to check delivery and
  acknowledge the outcome before sending again. A new matching
  user/queue receipt confirms delivery even if the command reply is lost;
  running state or assistant output alone does not confirm a particular send.
- `session-chat-transcript` projects provider-neutral items into stable turns,
  pairing tools/results by tool ID and preserving commentary, reasoning,
  unknown tools, orphan results and explicit failures. Fresh prompts alone opt
  into entry motion; initial history stays still. Claude's streamed and saved
  blocks can use different IDs and indexes. The view pairs corresponding blocks
  within the same provider message, keeps their position and render identity,
  and uses the saved content. Across a reset the projection keeps only matching
  render identities from the prior page. Raw history and pagination use the
  current provider IDs.
- The conversation-owned `ChatTranscriptProjection` reuses completed exchanges
  and unchanged tool steps, including parsed presentations. Runtime-only queue,
  usage and activity changes do not replace transcript inputs. Reset/paging
  replies reconcile equal records before projection; eviction and navigation
  release their cached turns. Streaming text changes only its active turn.
- The store keeps a bounded mapping from durable prompt IDs to their temporary
  render IDs and ephemeral send origins for the current transcript window. Receipt
  reconciliation retains the mounted turn and its animation; a receipt before
  the first paint also retains `isNew`, so the bubble and Working enter together.
  Older pages retain transcript order during a send. The pending prompt starts
  after the last visible record known at submit, and a matching saved receipt
  keeps its authoritative position in history.
  Domain intents keep the durable ID, and origin data never crosses the bridge.
  Paging prunes this mapping and session/backend navigation clears it.
- Queued messages retain their optimistic render IDs through saved receipts, too.
  The mapping is bounded by the current queue, pruned when messages leave, and
  cleared on session/backend navigation. Queue actions use the saved ID.
  Steer and an idle Resume show the outgoing prompt immediately. Automatic
  sends follow the engine's optional `state.dispatchingPrompts` signal, even
  before the native user item or any assistant output arrives. Queue removal
  alone can be a cancellation. The handoff reuses the normal bubble entrance
  and queue exit, preserves scroll following, and keeps the bubble mounted
  when the native item arrives. A rejected handoff restores its queue row when
  the engine still holds it. The temporary prompt never becomes a history
  cursor or a saved transcript record.
- `session-chat-tools` selects semantic verbs and bounded presentation blocks for all
  normalized tool kinds. Commands separate purpose, working directory, stdout/stderr
  and reported exit/interruption facts; file tools preserve code whitespace and
  show replacement diffs or colored patches. Search, web, plan, agent, question,
  workspace, symbol and skill tools expose their domain fields. Generic/MCP results
  unwrap text and structured data, avoid duplicate receipts and describe attachments
  without embedding untrusted media. Pending approvals use the same field renderer.
  `session-tool-focus` selects at most two short primary blocks per tool, keeping
  the useful result and avoiding repeated paths, parameters, IDs or routine success
  receipts. Commands use a short output tail; edits show the focused diff; plans
  favor unfinished work; web/MCP results favor titles and meaningful state.
  Full parsed evidence lives under Details; original data is nested beneath it.
  Shortened tool inputs/results do not add full-content buttons below the answer;
  tool evidence stays in the work timeline. Plans stay there instead of becoming prose.
- Codex history restores native command, patch, MCP and web-search receipts with
  the live stream's tool IDs and orders native prose and calls by their recorded
  start within the turn. Code-mode `exec` envelopes are omitted when native
  receipts supply the work, retaining separate output and exit/error status for
  each tool. Envelopes without supported native receipts remain inspectable.
  Codex assistant phases survive streaming and history reload. Earlier commentary
  stays with the turn's activity. When a run ends before posting a final reply,
  its latest commentary remains visible. Compact transcript exports label the
  latest interim text as Progress update until a final reply arrives.
- Claude tool calls share the same message/tool ID in live events and saved
  history. Split thoughts and text use the API block index when the saved
  record supplies it. Legacy split blocks that share an index retain separate
  identities. Pi uses the native message timestamp and occurrence for prompt
  and prose identities and the native call ID for all tool events. OpenCode
  waits for message metadata before publishing its parts and retains active
  parts and completed tools when a reconnect snapshot lags the socket.
- `SessionChatContent` reads original long messages, tool input and output in
  16,000-character pages. Its modal owns focus and cancellation. Content is
  rendered as text, including HTML returned by tools.

The backend adapter supports the registry's Claude, Codex, Pi and OpenCode
providers, with its existing prompt/queue/steer/stop semantics. Codex
projects native user-message receipts into the live transcript, including prompts
dispatched from the queue or steered into an active turn. Live and saved native
receipts share the provider item ID; rewind/fork retain their saved record anchors.
Duplicate start/completion events do not add another turn or reload history.
Desktop Codex
sends request acknowledgement once the runtime owns the turn, without keeping
HTTP open until generation finishes; existing completion-waiting callers retain
their default behavior. Later failures still use the runtime error/state feed. Questions include
Claude's permission-backed AskUserQuestion and provider-native questions/MCP
primitive form fields. Permission decisions target the actual pending request;
one-shot requests omit Always allow. Model/permission choices come from runtime
capabilities. Archived sessions are read only and load persisted history without
attaching a runtime.

## Background work and activity

`SessionActivity` in the composer controls summarizes work that outlives its turn
and runtime events worth noticing. It reads the optional `state.work` field, which the
backend's `desktop-chat-work` projection builds from the runtime's authoritative
`backgroundWork` list, enriched by its task/agent records:

- `running` (at most 16): live agents and background tasks with start time,
  latest summary/tool, usage, an orphaned flag (launched by finished work) and
  foreground/background identity, native lifecycle state, model and context occupancy,
  plus `stoppable` only when the harness implements the stop operation and reports
  the item stoppable. Foreground child agents are included; detached shell tasks
  still require the authoritative runtime registry. `totalRunning` preserves the
  count when more than 16 live rows exist.
- `recent` (at most 12, newest first): failed or cancelled hooks, finished/failed
  background work, retries while the affected run is active, context compaction,
  high-priority notifications, transcript sync and plugin failures. Successful or
  running hooks, progress ticks and quota data (owned by the agent menu) are dropped.

The trigger is absent when both lists are empty. With live work it reads
“N in background” plus the longest elapsed time, including after the reply ends.
Otherwise warnings/failures from the last 30 minutes flag “N issues” until the panel
is opened; older history leaves a quiet clock button. The CDK dialog traps and
restores focus, closes on Escape or
outside click, and stays open with an empty state if the work finishes underneath it.
Elapsed times tick locally (1s only while work runs); no extra reads are added:
the data rides the selected chat feed.

The panel lists **Needs you** (work waiting on a decision), **Running** and
**Recent**. Every row has the same shape so the list scans quickly: a status glyph,
the task title with a secondary agent identity, time in one right-hand column, and one
summary line. Only exceptions carry colour: the Needs you card and tags such as
“Left behind” or “Starting”. Model, usage and context belong to the agent
inspector, not the list.

Codex leads with the delegated task/path name (humanized for display), falling
back to the assignment's first non-empty line when the path is absent or merely
the agent role. Its nickname sits beside the title; the role stays in inspector
facts. Titles stay fixed while progress changes, and completed work and its saved
inspector use the same task title. Older engines retain their label/role display.

- `session-activity-model.ts` holds the pure presentation model: sections, the
  per-row tag/summary/accessible status, event output rules and formatters.
- `SessionWorkRow` (`ex-session-work-row`) and `SessionEventRow`
  (`ex-session-event-row`) are presentational list items (`role="listitem"`) sharing
  `session-activity-row.css`; they emit intents and own only local disclosure.
- `SessionActivity` composes them, owns the trigger, open state and the shared
  one-second clock, and forwards intents to the connected owner.

An inspectable row opens the agent from anywhere on the row. Stop and Run in
background share the time cell and appear on hover or keyboard focus (always
without hover); the requested row reads “Stopping…” until the command settles.
**Answer** appears on waiting work only while the conversation holds an approval
or question; it closes the panel and then focuses that decision, so the CDK focus
trap's restoration cannot win. Failure output keeps its lines in a code block
clamped to four lines, with a local Show more/less toggle.

Stop sends `{ type: 'stop-background', id }`. Main accepts only `task:`/`subagent:`
keys; the backend rechecks that the runtime still lists the item before calling
`stopBackgroundTask`/`stopSubagent`, so a stale row cannot stop reused work. The
turn itself is never interrupted, and the command is never replayed. The legacy
`activity` list is derived from the same projection (live work plus warnings) for
older desktops; engines without `work` show no activity trigger.
`session-activity.mjs` captures running, stop, issue, quiet and narrow
reduced-motion states in both themes.

The backend keeps at most 32 short-lived selected-session observations. It
subscribes before hydration and samples the feed revision before reading. The
next projection catches changes that arrived during the snapshot. When the
resume cursor is available, changed records and appended text fill the gap.
Persisted history is read at entry, explicit paging, history invalidation or
after a gap in the bounded live window. Simultaneous runtime/history reads
share their work. Providers still own source transcript reading. Their `getHistory`
interface currently returns full history inside the backend. The backend joins
saved and live rows at shared IDs before picking either page edge. Both paging
directions use the same row order and prompt context. The feed carries the last
observed live window through completion until the durable transcript contains
its rows. Explicit rewrites clear this handoff. Stream replay and legacy polls
send append/update events only with a verified overlap. Reorders and gaps return
a fresh bounded snapshot. Idle connections send transport heartbeats without
projecting a transcript. Legacy reads still wait up to eight seconds with an
unchanged cursor.

Progressive loading is enabled by default through
`SESSION_CHAT_PROGRESSIVE_LOADING`. The first request loads up to
**80 records / 512 KiB** with compact completed turns on supporting engines.
The viewport can prefetch older pages when idle to fill available space, within
a four-page budget and while each page adds visible height. Prefetch preserves
the latest records when the buffer fills. A cold conversation
open shows a transcript and composer skeleton after 150 ms. The real chat
renders as soon as the page is ready, with the latest reply positioned before
paint. The placeholder surface crossfades to that view over 140 ms while the
composer stays interactive. Reduced motion swaps the surface immediately.
Cached opens, new-session drafts and background history reads use their
existing content immediately. History prefetch preserves the reading position.

An override can start in window mode at **320 records / 2 MiB** and defer
older pages until scroll intent. If an uncached opening takes more than
**1,750 ms**, the application-wide `SessionChatLoadingPolicy` retries it in
progressive mode and switches the other chats on that connection. The deadline
applies only to uncached openings. Navigation, hiding, pausing and destruction
cancel it. Backend scope rotation and app restart reset the adaptive choice.

Preview application boundaries that override `BackendClientService` also provide
`SessionChatLoadingPolicy` at that boundary. Individual chat/workspace owners
inherit it, so recreating those owners cannot reset the connection's fallback.
The connected workspace preview accepts `?chatLoading=window` for exercising
the window-mode override and its fallback.

The optional `loadingMode: 'window' | 'progressive'` request selects these bounds
for latest/live reads. Adjacent history pages remain at most 80 / 512 KiB in both
modes so paging retains overlapping raw records and an inspected tool's anchor.
Omission retains legacy 80-item pages; older engines may
ignore the new option and continue returning those pages. Main validates the
option and the corresponding reply bound. Active-session fallback hydration shares
the backend's in-flight source/runtime reads; cancelled responses skip projection.
Cached reopening renders immediately and revalidates from its saved incremental
cursor, without blocking the composer or repeating an initial history read when
the feed is still current. The backend provider's source-history API remains a
full-history read, so a cold provider parse can still dominate initial latency.

### Saved turn activity

- A settled turn can occupy one saved entry with its prompt, latest reply
  blocks, elapsed time, counts by tool category, failures and the first three
  changed files plus the full file and line totals. Complete saved turns in an
  ordinary window and the paginated Changes review use the same reconciliation.
  The default profile requests compact entries for recent saved turns too.
  Older engines may return small recent turns inline. A prompt with no hidden
  work stays inline. The engine selects at most 40 summaries per history read
  and keeps the current live turn's stream and saved completion handoff
  available. Replies exceeding eight blocks or 128 KiB use the ordinary
  history window so all their visible text stays accessible.
- Summary selection occurs only at complete saved turn boundaries. Backward
  paging uses the prompt ID and forward paging uses the last source ID. A
  page starting or ending inside a turn uses ordinary rows at that seam.
  The renderer counts visible reply blocks toward its 320-record window.
- Opening Worked requests a compact timeline. Each tool call carries the same
  heading and outcome as the ordinary timeline, plus an optional result ID.
  Its paired receipt uses an empty source slot or carries bounded image
  references. Viewed images render inside the matching tool disclosure. Other
  inline previews retain their receipt positions. Commentary and
  the visible reply stay in order. The entire timeline appears in one update.
  Batches beyond 512 KiB or 8,192 source slots are fetched automatically in source
  order, independent of the chat's scroll direction. Older engines keep their
  ordinary work pages. Every batch must match the turn revision and advance
  contiguously before the view publishes the timeline. Repeated provider row IDs
  retain their first position and latest value.
- The window-local cache retains up to 16 complete snapshots or 1.5 MiB of
  serialized data, keyed by backend scope, task, session and turn revision.
  A 220 ms mouse dwell over the reply, keyboard focus on Worked, a 60 ms dwell
  on Worked itself or a press on it (before the click lands) can warm an
  activity batch even while another disclosure is loading.
  Moving within the same turn preserves the dwell. Opening joins an active read,
  continues a warmed first batch from its cursor, or uses the complete snapshot
  immediately. Up to three unopened warm-ups (one batch each) keep running, so
  moving between turns lets earlier reads finish into the cache; returning to
  an in-flight turn reuses its read. A fourth uncached dwell cancels the oldest
  warm-up, including a held first batch of a large turn. Closing the
  disclosure cancels its read until a fresh interaction. Hiding the chat or
  switching conversations cancels pending reads.
  Scope and revision changes discard stale results. A sustained dwell can warm
  the current revision when the conversation is available again.
- The reply and counts stay available throughout. Open sections and tool
  disclosures survive releasing a turn's rows after collapse. Reopening
  stages previously visible tool evidence alongside the compact timeline.
  Unopened groups mount their count controls and defer their folded tool rows.
  A failed read offers retry in place. The reveal respects reduced motion.

### Tool evidence

Normal windows, live updates and saved activity pages opt into deferred tool
details. Compact timeline tools share their enclosing turn revision and resolve
their call and receipt within that exact saved turn. Ordinary rows carry
individual evidence revisions. Counts, file-change metadata and inline media
references remain available. Older engines can send inline evidence with the
same row UI.

Viewed images load by receipt and media ID when the tool body opens. The same
bounded media reader serves the live chat and saved timelines. Closing the
tool releases the image after its exit. An image whose call is on another page
opens in its Result row.

Opening a tool starts one bounded read for its call and its receipt when
available. A 100 ms hover or visible focus on a closed tool heading, or a press
on it, warms that same read first. Up to four unobserved warm-ups run at once;
a newer intent beyond them cancels the oldest, an open adopts its warm-up and
frees that slot, and a completed warm-up leaves only its cached evidence. Failed warm-ups stay uncached, and hidden or disconnected
chats drop them. A raw history page that contains only the receipt shows a named
Result row and opens that same pair. A result without a known call opens by
its own identity. Collapsed tool bodies stay deferred while the reader scans
the timeline or expands a group. The
conversation owner shares an in-flight request for matching open references and
cancels it when the last observer closes, leaves the current page or changes
session. A receipt arriving for an open call changes its reference and replaces
the requested evidence in place. Hidden or disconnected chats pause pending
reads. Closing the tool releases the mounted evidence after its exit.

Successful reads are kept in a window-local LRU of 48 entries and 1 MiB of
serialized evidence. Entries are scoped by machine, task, session and either the
saved turn revision or the individual item revisions. The heading stays in place during a read, then the evidence
opens in one fold. Failed reads can be retried in place. Evidence
uses the existing preview, Details and original transcript reader.
Counts describe observed operations, including calls whose completion is
unknown. Codex compound reads show their other paths and reported command steps
in the evidence. Saved image views are tool operations with recorded paths and
use the same confined media reader as other transcript images.

### History window and related reads

History windows also carry an optional
bounded `leadingPrompt` when the first item belongs to an earlier user message.
That prompt supplies the turn identity and reminder without moving the page cursor
or claiming that the intervening evidence has loaded. It survives item eviction
and cached reopening, and disappears when its actual user row enters the window.
Older engines can omit it. The visible live window retains
at most 320 items. Scrolling near either edge automatically loads an adjacent page and evicts
content at the opposite edge above 320 items. Stable row anchors preserve the
reading position, and loaded history never opts into arrival motion. The optional
`following`/`next` contract continues forward without gaps while live state keeps
refreshing. Live state changes update the composer and the identified active
turn when a slice of it is visible. Sending reconciles the live tail first, and the draft
stays editable while reading. Engines without forward cursors retain an automatic return to their tail
when scrolling down through an evicted window. Ordinary display text is shortened at 16,000 characters,
with explicit access to the original paged content. State, queue, model and
activity collections have separate finite bounds; main caps the complete reply
at 4 MiB. Feed expiry/rewrite produces a fresh bounded tail rather than a
pretend lossless event log.

The integration deliberately hides unavailable dictation, mention,
fork, side-chat and queue edit/reorder controls. File links request the selected reply’s Changes
panel; external HTTP(S) links use the existing main-process navigation policy.
Richer MCP schemas remain a separate integration. Child transcripts open
on demand through `sessionChatAgent`; pages join a bounded 320-item scrolling window,
reject stale replies and cancel on close/navigation. Evicted agent pages retain
only their opaque request cursor so scrolling down can reload the same snapshot. The inspector (`SessionAgent`)
pins the assignment above the transcript (folded when long) and drops the
duplicate opening user message. Tool calls and their results render as the main
thread's `ToolStep` rows; reasoning folds locally. A waiting agent points to the
main conversation, which owns decisions. Messages load automatically at either
scroll edge, and the footer states when the snapshot loaded; Refresh is the header's icon action. While
the agent is still listed, its live record supplies the split title/role and the
reported usage (tokens, tools) for the header. See [cross-harness Activity design](../../../../../docs/session-activity.md) for provider support and feature boundaries. The desktop connection layer and legacy app are unchanged.

Run the standard desktop checks and the backend `desktop-chat.service.spec.ts`.
The preview-only `SessionChatFixture` powers the connected workspace and
`scripts/desktop-capture/scenarios/session-chat.mjs`; it never enters the
production import graph. It verifies themes, tools, decisions, responsive typing,
draft retention, delivery uncertainty, original-output pages, history and reduced
motion through the real Angular components.

## Harness choice

The composer’s agent chip opens settings with a Harness segment using the connected backend registry's
bounded provider labels (currently Claude Code, Codex, Pi and OpenCode). Optional
`providers` and `providerLocked` state fields keep older engines compatible;
without them, the desktop retains its previous read-only harness display.

A pre-start selection persists through the existing session provider operation.
Its command carries the expected current provider, validates registration and
pending work, and reuses the same native-conversation lock as legacy/MCP callers.
The draft stays editable and retained while the owner rejects old provider reads,
reconciles the new selection and loads that harness's model/permission options.
Interrupted changes are never replayed. Started conversations keep their harness;
create a new session to choose another.

Cold sessions are observed without invoking provider attachment/prewarming hooks.
A non-initializing runtime-state read prevents OpenCode from creating a native
conversation just by displaying the picker. Once a native conversation starts,
the existing attachment lifecycle resumes. Existing one-argument runtime reads
retain their previous initialization behavior.

`session-harness.mjs` verifies real radio-group keyboard navigation, all advertised
choices, changing back and forth, draft retention, model refresh, narrow layouts,
both themes and locking after the first prompt with preview-only provider data.

## Reply boundaries

The latest nonempty assistant reply stays outside collapsed work even when a
harness appends tool receipts or system records afterward. If there is no final
reply yet, the latest available prose represents the turn. Earlier commentary
and trailing work evidence remain inspectable in the timeline.

A locally sent prompt owns early runtime output until its durable user receipt
arrives. Projection inserts that pending boundary before newly arriving items;
reconciliation orders a late receipt before output already received for it.
Queue feedback has separate ownership and cannot replace the active pending
prompt. Only the current reply streams; waiting, tool work, completed turns and
retained thinking lines do not retain an answer cursor. Empty/loading states
follow the projected conversation, so the first send immediately replaces the
welcome card even before history contains a user item.

`session-reply-boundaries.mjs` reproduces trailing records and deliberately late
user receipts through the preview adapter in light/dark and narrow layouts.

The projection supplies `answerBeforeStepId` for work following the latest
assistant text. The projection also supplies `answerId`, so that message keeps the same
Markdown instance when it becomes earlier commentary. Tool results remain paired
with their original calls, even across a steered prompt. A late receipt updates
its call in place. One
flat timeline retains tool instances, disclosure and focus across message boundaries. `session-work-order.mjs`
checks this ordering, tool/work disclosures, top hover/focus summaries, keyboard
operation and narrow reduced-motion layouts in both themes.


## Designed composer

Reasoning choices come from each model rather than a generic harness-wide fallback.
Codex preserves its ordered `supportedReasoningEfforts`; Claude uses its SDK's
`supportedEffortLevels`. OpenCode filters disabled native variants, orders known
efforts from low to high and retains custom variant IDs in their native order.
Pi uses its model thinking mappings (including off/minimal and explicit xhigh/max
support), reconciles a live selection with `get_available_thinking_levels`, and
applies changes through `set_thinking_level` before prompting. Catalog failures
and unknown model capabilities do not invent supported efforts. Both live
settings and preset catalogs carry these same per-model capabilities.

An explicit Claude model selection is saved with its session and restored before
the first chat read or CLI launch after a backend restart. It retains its catalog
alias across context updates, preserving custom display names and per-model
thinking choices. When the runtime only reports a wire model ID, the SDK's
`resolvedModel` catalog field supplies the match. Model changes publish state
before startup and apply to a warm query in place. Native model-change receipts
are control traffic and are omitted from live and saved conversation turns.

The connected chat now uses `Composer`’s Plan/Code switch, agent chip and
permission picker directly. Harness, model, thinking and fast mode live inside
the agent popover; the toolbar stays on one row. All choices use authoritative
model catalog entries; chat and preset selectors never add a synthetic provider
default with unknown capabilities. An unresolved model prompts Choose model
without guessing its identity or thinking support. All changes use authoritative
state with busy/error handling, retain the draft, and reject archived/historical
edits. Harness changes retain the agent menu and its focus while the new catalog
loads; settings and sending stay blocked until the new provider is confirmed.
Engines advertising `presetCatalogs` also supply the selected harness's model
list independently of a running conversation. One scoped catalog read starts
when that session/harness becomes active; live runtime model capabilities take
precedence, with the catalog filling a cold runtime's empty list. Discovery
shows loading and retryable errors, and the agent menu's Refresh models action
requests a fresh provider probe. Selection, machine changes and teardown cancel
the read and discard late replies. This never submits or replays a prompt.
Escape or an outside click dismisses the menu and restores its opener.
Queue removal/steering restores composer focus before a row disappears.
Enter sends or queues, Alt Enter steers, Shift Enter inserts a newline, Shift Tab
toggles mode, Cmd/Ctrl J opens agent settings and Cmd/Ctrl . stops a running agent.

Optional `controls`, `fast` and model capability fields are additive for older
engines. Thinking and fast changes use validated actions on the existing named,
scoped command bridge. The backend checks the selected model before delegating,
and advertises only installed provider operations. Catalog discovery probes only
the selected provider, without starting its conversation or reading repositories.
Missing capability metadata hides the
new controls. Mentions, dictation and preset/fork integrations
remain hidden until their corresponding platform operations are available.

`session-composer.mjs` verifies settings, nested Escape/focus, keyboard modes,
permissions, multiline input, queue/remove/steer/stop, retained uncertain drafts,
container-responsive layout and reduced motion in both themes. `session-harness`
verifies changing harness inside the popover and locking after the first prompt.
`session-model-discovery.mjs` covers a cold runtime, discovery loading/failure,
explicit refresh, recovery without sending, retained drafts and restored focus
in both themes, including a narrow layout with reduced motion.

The agent menu follows the standalone ZIP’s fixed-column form and usage block.
Live context/token values come from the selected session. Optional `planUsage`
now crosses the existing scoped chat feed and runtime-validated desktop bridge.
Only matching Codex/Claude OAuth subscription data is projected; API-key sessions,
older engines and unknown usage omit the quota UI. At most eight provider windows
cross the bridge. Their remaining percentages drive the clock ring, delayed
hover/focus card, menu bars and low/exhausted notices above the composer.
Reset times use the user's locale and refresh while mounted. Passing a reset
does not invent replenished allowance: the display waits for a provider update.
Claude reads subscription windows through the optional native SDK usage API on
prewarm, runtime reads and activity, with coalescing and a one-minute cache per
runtime (including failures). The read skips behavioral transcript scans, never
starts a process, and publishes independently of context/model reads. Its
availability flag establishes subscription data before the first prompt; explicit
API-key metadata suppresses it. Live subscription rate-limit events remain a
fallback for older CLIs and supersede pending reads. Retired runtime replies are
discarded. Codex uses its existing coalesced account-limit refresh and notifications.
No extra repository reads, account credential access or renderer networking is added.
The notice follows the design's context/quota priority and returns focus to the
composer on dismissal. Automatic plan pausing/resume, Send at reset, cross-agent
forking and account-wide island notifications need platform execution support;
this display integration does not promise or simulate them.
The menu’s snapshot stays mounted through
its inert exit. The dedicated `/agent-picker` preview and `agent-picker.mjs`
verify the full reference component independently of transcript motion.

`session-quota.mjs` exercises connected quota updates, the tighter weekly/model
window, hover and keyboard disclosure, low/exhausted states, dismissal focus,
missing/API-key data and narrow reduced-motion layouts in both themes.


The component-owned `SessionChatPresets` controller owns preset view models, stable chosen identities, the retained creator draft and stale/disposed reply checks. Transcript state remains in `SessionChatStore`.

Starting presets use the optional bounded `SessionChatState.presets` capability.
The blank chat centers one composer beneath the starting presets, with the
welcome area scrolling independently on short windows. Custom opens the preset
creator with the current harness, model, thinking and fast-mode configuration
and an empty name. Editing or cancelling
this local draft leaves the conversation settings unchanged. A saved-card
selection submits one
`preset` action, validates the entire mix before applying it, reconciles state,
and restores typing focus only while the same session is selected. Typing and
its draft remain available during configuration. Started sessions and archived
history do not expose starting choices. Engines omitting presets keep the agent
picker and composer without unsupported controls.

New preset and the agent menu’s Save as preset open a local named draft for the
initially selected harness, with an editable Harness dropdown when the engine advertises `presetCatalogs`. Model, supported thinking levels and fast mode stay
local until Create. A `save-preset` command carries a stable draft identity;
settings append it transactionally to the existing 24-preset storage, without
changing legacy startup defaults. Successful saves put the new card first and
apply it to this unstarted session. Rejected saves retain the draft; uncertain
writes use the existing explicit conversation reconciliation and are never
replayed. Closing a pending creator or changing sessions rejects late UI work.
The backend checks workspace/session ownership and prevents other desktop chat
commands from interleaving with a preset application. Partial
provider failures retain saved presets and require inspecting reconciled agent
state. Editing a preset never starts a runtime or sends a message; Create applies settings through the chosen harness’s existing setters.


The optional `presetDefault` snapshot enables the quiet Default dropdown above
the cards. It changes the connected machine's default provider/preset and applies
that mix to the current blank chat. Ordinary card selection remains session-only.
The Default card label and selected ring have separate meanings. The dropdown
lists the existing bounded 24-preset catalog. Engines without `presetEditing`
retain a six-card window that makes room for the selected and default presets.

With `presetEditing`, the first six entries get full cards and Option+1–6.
The remainder follow in responsive slim rows, with Custom last in the entire
order. The blank chat previews up to two slim rows and compacts as vertical
space shrinks. Edit shows the entire catalog and keeps New preset in the heading.
The composer stays visible with its draft and becomes interactive again on Done
or Escape. In Edit, click a card or its pencil to open the retained preset
dialog. On the start screen, a pencil or E on a focused card opens that dialog
in place.
Drag a grip or use Option+Arrow keys to reorder. Remove or Delete offers a short
undo window.
Removing the default selects the first eligible preset in the remaining order.
Undo restores the original position and defaults if the catalog revision is
still current.

When a user adjusts the starting preset through the composer, the grid retains
the association with the saved preset and the callout shows the changed fields.
Revert applies the saved mix to the current chat. Update preset writes the
current mix to the saved preset, and Save as new gives the mix its own name.
The existing edit dialog can also take the current mix as a draft. If the
chat still uses the preset being edited, saving a changed mix reapplies it.
Chat-specific adjustments are preserved.

Update, reorder, remove and restore actions compare the catalog revision
inside the settings transaction. They can change future defaults and update
active chat feeds while leaving the current conversation's agent intact.
Reorder preserves stored slots for unregistered harnesses, and deletion of a
legacy default clears the legacy values that could regenerate it on reload.

Default writes and creator choice reuse existing settings columns. A settings
transaction compares a revision of the provider and canonical preset catalog,
then writes the provider and default flags together. Replies include validated
before/after snapshots for a seven-second Undo notification. Undo restores future
provider defaults without changing the current agent or deleting a new preset.
Its revision precondition rejects overwriting another client's later edits;
neither writes nor Undo replay after reconnection. A new toast identity resets
its timer, and its owner clears notifications/stale replies on navigation.
Older preset-capable engines without this field retain their existing controls.


The creator groups its default preference below the agent controls, using SetRow and
Segmented. Keep current preserves the saved default; Use this preset requests
the new default when Create succeeds. Both choices have full button targets and
radio keyboard navigation, and disable while busy, blocked or closing. The
creator initially chooses Use this preset when the backend reports no default,
and Keep current when a default already exists. That initial preference is
captured when the draft opens; explicit edits survive harness/model changes.
The selected choice stays local until creation. No default mutation happens
while editing this form.

The backend separately remembers the last successfully used harness, model,
thinking level and fast mode after agent changes or accepted sends. New sessions
use this persisted mix when no explicit preset or legacy provider default is
configured. Explicit session harness choices and configured defaults win;
remembering a mix never creates a preset or adds a Default label. Passive reads,
failed commands and default Undo do not replace it. The additive settings
migration preserves it across backend restarts without a renderer cache.


The optional `presetCatalogs` capability adds the named scoped
`sessionChatCatalog` read through the same per-window backend client. The
`PresetCatalogProvider` captures the selected task/session and draft identity,
validates scope before/after dispatch, and maps supported metadata into renderer
view models. The form owns one abortable request and a bounded per-harness draft
cache. Models load independently of a session runtime; changing a harness in the
creator does not persist the chat provider, select a model on a running agent or
start a conversation. Explicit retry refreshes the provider-owned model cache.

Create sends optional `save-preset.provider` plus the original chat's
`expectedProvider`, validates the selected catalog before saving/applying the
mix, and retains the existing stale/uncertain-write policy. Omitted `provider`
retains older callers' current-harness semantics. Engines without the capability
keep their locked creator rather than issuing unsupported reads.

## Reply changes

Completed replies supply the designed file chips, counts, overflow and Review
button from optional bounded transcript `changes` metadata. Main validates it;
older engines can omit it. Persisted net captures include shell edits and survive
history reloads. Successful native edits provide a fallback; failed/pending calls
do not claim changed files. Captured unchanged paths remove reverted edits, while
explicit edits outside the captured repository survive reconciliation.
An ignored file observed without a starting state only contributes when a
successful tool supplies evidence for that path. Verified binary and mode-only
changes still contribute to the file count.

`SessionChat.reviewRequested` carries the selected scope/task/session, stable
reply ID and optional file path. `MachineWorkspace` owns that selection and
projects `SessionChatReview` into the Changes panel. The named
`sessionChatChanges` operation reads only recorded reply changes, never arbitrary
filesystem paths. It validates task/session membership, file identity and revision.
Closing/hiding the panel, switching session or destroying its owner cancels reads;
late responses cannot update another selection. No mutations are retried.

Summaries include at most 200 file entries plus the full count. Reviews page
100 file records, render the existing 12-file window, and lazily read at most
three diffs concurrently. The backend coalesces and briefly retains one prepared
reply per feed, invalidated by transcript revisions, so scrolling does not reread
the complete provider history for each file. Content pages contain at most 400 lines / 128 KiB,
with bounded line text and explicit next/previous controls. The owner caches at
most one file page and one content page per file (100 maximum). Captured patches
are decoded linearly in the backend; native fallback computation is limited to
320 completed calls / 256 KiB, with individual inputs capped at 32,000 characters.
Full-file browsing, Code opening and comments stay hidden because recorded turn
diffs do not supply those platform operations.

`session-changes.mjs` verifies creation, exact file selection, Review via keyboard,
wide/compact panels, 1,001-file summaries, line pagination, errors and narrow
reduced-motion layouts in both themes through the production composition.


Codex file-change receipts distinguish whole-file add/delete content from update
patches. Native additions/deletions can place raw file text in a field named
`diff`; the presenter renders these as before/after diffs rather than assuming
prefixes already exist. History decoding adds `diffFormat: 'content'` when the
source explicitly supplies content, retaining the legacy diff text and avoiding
ambiguity when a newly added file is itself a patch document. Older receipts use
the change kind plus actual unified-hunk syntax. Empty files and missing inline
content stay distinct; display normalizes CRLF and removes one terminal split
sentinel without stripping meaningful spaces or blank lines.

Chat images use optional, bounded `SessionChatItem.media` references and the named
`sessionChatMedia` bridge operation. Inline Codex/native/MCP previews stay at the
tool receipt's position in the work timeline, including results that arrive
after later messages. Authored Markdown images remain in their original message.
Both resolve through the selected-session media owner. Binary image data never
enters transcript text or triggers the raw output overflow control. Ordinary
shortened text keeps the full-content reader.

`SessionChatMedia` owns the newest 12 distinct media paths in the displayed
transcript, including its retained prompt and reply context. It preserves loaded
sources across paging, limits reads to three in flight and caps source data at
48 MiB. Evicted references cancel their reads, and replies are validated against
the current reference and selection. Loading/read/decode errors
are explicit. Leaving the session releases sources and queued work. Older engines
can omit media metadata. This slice supports PNG, JPEG, GIF and WebP; it does not
fetch external URLs or execute SVG/HTML.

Backend reads revalidate task/session/item membership and select a recorded
attachment ID rather than accepting arbitrary renderer paths. Referenced file
images must resolve inside the session workspace or, for Codex, its configured
`CODEX_HOME/generated_images` directory (`~/.codex/generated_images` by default).
Real paths, regular-file checks, signature validation and an 8 MiB byte limit
confine reads. Remote image bytes travel through the main-owned backend client;
renderer CSP and credentials remain unchanged. Per-feed weak projection caches
avoid reparsing unchanged binary tool results during streaming polls.


## Sending files

Engines advertising `attachments` enable the dedicated paperclip (Cmd/Ctrl U),
multiple selection, file paste and file drop anywhere in the selected conversation.
The presentational Composer accepts controlled `attachments`, `attachmentsEnabled`,
`attachmentRemoved` and `attachmentRetry`; it emits browser Files through
`filesAttached`. Files-only sends are allowed once every upload is ready.
Unsupported engines and read-only/historical sessions keep uploads unavailable.

`SessionChatAttachments` owns a sequential upload worker, abortable FileReaders,
progress, explicit retries, cancellation and selection guards. Workspace-owned
`SessionChatDrafts` keeps the selected files while navigating; pending/failed sends
retain them with their text. Uploads never prompt the agent. The existing delivery
reconciliation compares the full prompt, including stable attachment references;
uncertain sends require checking delivery and never replay automatically.

The named `sessionChatUpload` bridge carries at most 512 KiB per chunk through the
existing per-window backend scope. The backend revalidates task/session membership
and active workspace ownership for each chunk. Exclusive private directories,
ordered offsets, non-following file opens, bounded writes and atomic publication
keep partial files out of the transcript. Pending uploads expire after ten minutes
or clean shutdown. Completed files remain in the engine's app-data directory at
`chat-attachments/<session>/<uuid>/<safe-name>` so queued prompts and reopened
history retain valid references. They are outside the checkout and git changes.
Completed uploads are retained even when removed from a draft: removal cannot
invalidate another queued/sent reference to the same file. Unsent drafts are kept
in memory for this workspace window, not across application restarts.

Limits are eight files, 20 MiB per file, 32 MiB per draft and 8 MiB of native
images per draft. PNG/JPEG/GIF/WebP bytes use native image input when the selected
harness supports it. Videos and other files are supplied as absolute local-file
references to the agent; processing depends on its model/tools. SVG, HTML and
other documents remain file cards and are never executed or embedded.

Provider history retains ordinary named Markdown links. Projection recognizes only
our private upload namespace, emits bounded image/video/file metadata, and avoids
duplicating provider-native image blocks. The transcript shows supplied images in
the existing accessible image viewer, videos in the existing recording player,
and documents as named cards with Copy path. A standalone Markdown embed such as
`![Walkthrough](artifacts/run.webm)` can also show a recording from the session
workspace in an agent reply. Media reads select a recorded item and attachment ID,
validate signatures, and confine recordings to the workspace or that session's
upload directory. Video data is limited to MP4/WebM/Ogg and 20 MiB per file. Codec
failures remain readable. The desktop CSP permits local data media.

The preview adapter and `session-attachments.mjs` exercise native file selection,
DOM paste/drop, files-only sends, retry/removal, viewer focus, playback and both
themes/narrow reduced-motion states. Provider execution is covered by backend
regressions rather than sending a paid prompt during visual verification.

## Disconnected writing

Workspace-owned `SessionChatOutbox` keeps up to twenty unsent messages, answers,
approval responses and Stop intents with a main-owned journal (512,000 serialized action
characters total, 128,000 per action). Local waiting rows are separate from the
backend-accepted queue. Messages remain editable/removable before dispatch;
actionable decisions can be removed. A fresh membership/state read precedes each
first dispatch. Expired question/permission IDs and Stop for a different or
unidentified turn are rejected with “Nothing was sent.” Sending while a turn is
still active enters the backend's ordinary accepted queue.

Each action is claimed before IPC dispatch. Lost replies become visibly
unconfirmed and block following writing in that conversation, never re-entering
the waiting queue. Check delivery reads the current bounded conversation and
compares new durable user/queue receipts with the pre-dispatch snapshot; it sends
nothing. Without a matching receipt, the person inspects and explicitly
acknowledges the uncertainty. Confirmed backend queue controls keep their existing
semantics and are not blindly replayed. Changing machine or destroying the owner releases its in-memory requests. Waiting
writing is retained per window and configured machine across app restarts. The
main process validates and atomically journals a sending claim before IPC
dispatch; interrupted claims restore as unconfirmed, never as waiting. SSH
credential prompts cannot enter this journal. Restored interrupted prompts without
a retained receipt baseline require explicit conversation inspection.

Draft text, files, mentions and in-flight uncertainty share the retained entry
through a same-machine scope rebind. Late command results update their original
draft entry without overwriting another session. Local draft storage is
independent of the waiting-action journal. It cannot dispatch messages. Up to five transcript snapshots
of one million serialized characters each retain loaded conversations for offline
navigation, alongside the existing 320-item live window and ordinary twenty-draft
cache. Unresolved draft uncertainty keeps its existing preservation policy.
Session reads pause on outage, Home, document hiding and disposal. Reconnect does
not replay prompts, upload mutations, settings or accepted queue operations.

A verified same-machine scope rebind keeps the conversation's `viewRevision`,
render identities and consumed cursor. The fresh request resumes incrementally
when that cursor remains valid; a backend reset can still request a bounded
replacement window. Earlier-history views stay on their loaded page until the
person chooses latest. Backend scopes continue to gate every platform operation;
they are not used as the UI's scroll/open lifetime. `session-reconnect-reading.mjs`
checks actual reading position and unread feedback through recovery.

During recovery, earlier local writing drains before a new direct submission can
overtake it. The input remains editable. A paused backend queue stays paused;
automatic delivery joins that queue instead of restarting the agent.

## Tool timeline and original content

Each activity section has its own recent-work budget. Running and unknown calls
stay visible, and a late result updates its original call and section. Paired
text-only results do not break adjacent reply blocks or interrupt newer
thinking. `session-tool-timeline.mjs` exercises these transitions, repeated and
interrupted disclosures, full-output paging and paired call/input selection with
provider-shaped fixtures in the connected preview.

Shortened tool evidence carries explicit call/result IDs in `WorkStep.fullContent`.
The connected owner resolves the available pair for the original-content reader.
Input reads target the call; output reads target its receipt. Tab changes start
at offset zero, cancel previous reads and reject stale responses. A message or
an orphan result never displays an input tab for a missing call. The reader
retains existing machine scope checks, bounded pages, inert text and cancellation
on close/navigation.

## Visual element mentions

`stageBrowserContext` stages a picked element as a first-class attachment with its original browser crop. `SessionChatAttachments.addElement` assigns the lowest free pin (❶–❽) and `Composer.insertElement` places it at the caret; send rejects markers with no element. The additive `browserElements` chat and `elementSnapshots` browser capabilities preserve older hosts and gate the Composer pick entry points. See [capture, delivery and recovery](../../../../../docs/browser-element-mentions.md). Source hints remain optional.
