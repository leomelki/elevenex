# Connected session chat

`SessionChatComponent` is the production adapter for a selected
`{ scopeId, taskId, sessionId }`. It composes the conversation family's public
components; those components remain independent of the bridge and providers.
`MachineWorkspace` provides the chat client and drafts at workspace lifetime,
so nested/preview backend scopes resolve consistently.

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
- `SessionChatStore` owns one visible transcript window, long reads, mutation
  epochs and feedback. It cancels reads on navigation, hiding or destruction.
  Pending writes can finish on their original backend; their replies never
  change a different conversation. No write is replayed by reconnect or refresh.
  Idle heartbeats retain unchanged conversation inputs. Transient background
  read failures retain the transcript and retry quietly; initial/explicit reads
  and unsupported-engine errors still expose recovery feedback.
  Confirmed non-configuration actions reconcile through that same quiet,
  incremental read path. Repeated visibility notifications share the active read.
- `SessionChatDrafts` retains at most 20 ordinary session drafts per workspace
  scope. Unresolved writes are not evicted silently. A failed send restores its
  text ahead of any newly typed draft. An uncertain outcome requires checking
  delivery and explicit acknowledgement before another send. A new matching
  user/queue receipt confirms delivery even if the command reply is lost;
  running state or assistant output alone does not confirm a particular send.
- `session-chat-transcript` projects provider-neutral items into stable turns,
  pairing tools/results by tool ID and preserving commentary, reasoning,
  unknown tools, orphan results and explicit failures. Fresh prompts alone opt
  into entry motion; initial history stays still.
- The store keeps a bounded mapping from durable prompt IDs to their temporary
  render IDs and ephemeral send origins for the current transcript window. Receipt
  reconciliation retains the mounted turn and its animation; a receipt before
  the first paint also retains `isNew`, so the bubble and Working enter together.
  Domain intents keep the durable ID, and origin data never crosses the bridge.
  Paging prunes this mapping and session/backend navigation clears it.
- Queued messages retain their optimistic render IDs through saved receipts, too.
  The mapping is bounded by the current queue, pruned when messages leave, and
  cleared on session/backend navigation. Queue actions use the saved ID.
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
  the live stream's tool IDs. Code-mode `exec` envelopes are omitted when native
  receipts supply the work, retaining separate output and exit/error status for
  each tool. Envelopes without supported native receipts remain inspectable.
- `SessionChatContent` reads original long messages, tool input and output in
  16,000-character pages. Its modal owns focus and cancellation. Content is
  rendered as text, including HTML returned by tools.

The backend adapter supports the registry's Claude, Codex, Pi and OpenCode
providers, with its existing prompt/queue/steer/stop semantics. Desktop Codex
sends request acknowledgement once the runtime owns the turn, without keeping
HTTP open until generation finishes; existing completion-waiting callers retain
their default behavior. Later failures still use the runtime error/state feed. Questions include
Claude's permission-backed AskUserQuestion and provider-native questions/MCP
primitive form fields. Permission decisions target the actual pending request;
one-shot requests omit Always allow. Model/permission choices come from runtime
capabilities. Archived sessions are read only and load persisted history without
attaching a runtime.

## Background work and activity

`SessionActivity` in the session bar summarizes work that outlives its turn and
runtime events worth noticing. It reads the optional `state.work` field, which the
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
“N in background” plus the longest elapsed time, and the session status becomes
“Working in background” after the reply ends. Otherwise warnings/failures from the
last 30 minutes flag “N issues” until the panel is opened; older history leaves a
quiet clock button. The CDK dialog traps and restores focus, closes on Escape or
outside click, and stays open with an empty state if the work finishes underneath it.
Elapsed times tick locally (1s only while work runs); no extra reads are added:
the data rides the existing long-poll feed.

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
subscribes before hydration, then uses a pre-read cursor and idempotent changed
item replacements to reconcile events during the snapshot. Reads wait up to
eight seconds for activity; the renderer spaces active reads by 80ms. Persisted
history is read at entry, explicit paging and durable history invalidation,
never for each streamed token. Simultaneous runtime/history reads share their
work. Provider APIs still own source transcript reading; their `getHistory`
interface currently returns full history inside the backend. Only bounded tails
are copied/projected and transported to the renderer.

History pages contain at most 80 items / 512 KiB; the visible live window retains
at most 320 items. Earlier pages replace the window and pause live following
until Back to latest. Ordinary display text is shortened at 16,000 characters,
with explicit access to the original paged content. State, queue, model and
activity collections have separate finite bounds; main caps the complete reply
at 4 MiB. Feed expiry/rewrite produces a fresh bounded tail rather than a
pretend lossless event log.

The integration deliberately hides unavailable dictation, mention,
fork, side-chat and queue edit/reorder controls. File links request the selected reply’s Changes
panel; external HTTP(S) links use the existing main-process navigation policy.
Richer MCP schemas remain a separate integration. Child transcripts open
on demand through `sessionChatAgent`; pages replace the bounded history window,
reject stale replies and cancel on close/navigation. The inspector (`SessionAgent`)
pins the assignment above the transcript (folded when long) and drops the
duplicate opening user message. Tool calls and their results render as the main
thread's `ToolStep` rows; reasoning folds locally. A waiting agent points to the
main conversation, which owns decisions. Show earlier/newer messages sit at the
transcript's edges, Jump to latest appears only on an earlier page, and the
footer states when the snapshot loaded; Refresh is the header's icon action. While
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
harness appends tool receipts or system records afterward. Earlier commentary and
trailing work evidence remain inspectable in the timeline.

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
with their original calls; late receipts do not move calls past the reply. One
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

Claude model selections retain their catalog aliases across startup and context
updates, preserving custom display names and per-model thinking choices. When
only a wire model ID is known, the SDK's `resolvedModel` catalog field supplies
the match. Model changes publish state even before a runtime starts; a warm
query applies them without rebuilding the process. Native model-change receipts
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
Escape or an outside click dismisses the menu and restores its opener.
Queue removal/steering restores composer focus before a row disappears.
Enter sends or queues, Alt Enter steers, Shift Enter inserts a newline, Shift Tab
toggles mode, Cmd/Ctrl J opens agent settings and Cmd/Ctrl . stops a running agent.

Optional `controls`, `fast` and model capability fields are additive for older
engines. Thinking and fast changes use validated actions on the existing named,
scoped command bridge. The backend checks the selected model before delegating,
and advertises only installed provider operations. No extra catalogs, provider
hydration or repository reads are added. Missing capability metadata hides the
new controls. Mentions, dictation and preset/fork integrations
remain hidden until their corresponding platform operations are available.

`session-composer.mjs` verifies settings, nested Escape/focus, keyboard modes,
permissions, multiline input, queue/remove/steer/stop, retained uncertain drafts,
container-responsive layout and reduced motion in both themes. `session-harness`
verifies changing harness inside the popover and locking after the first prompt.

The agent menu follows the standalone ZIP’s fixed-column form and usage block.
Live context/token values come from the selected session. Optional `planUsage`
now crosses the existing scoped chat feed and runtime-validated desktop bridge.
Only matching Codex/Claude OAuth subscription data is projected; API-key sessions,
older engines and unknown usage omit the quota UI. At most eight provider windows
cross the bridge. Their remaining percentages drive the clock ring, delayed
hover/focus card, menu bars and low/exhausted notices above the composer.
Reset times use the user's locale and refresh while mounted. Passing a reset
does not invent replenished allowance: the display waits for a provider update.
Claude data becomes available when its SDK emits subscription rate-limit events;
Codex uses its existing coalesced account-limit refresh and notifications.
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
The blank chat centers one composer beneath at most six reference preset cards
and Custom, which opens the preset creator with the current harness, model,
thinking and fast-mode configuration and an empty name. Editing or cancelling
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
The Default card label and selected ring have separate meanings. A bounded
six-card window retains a selected/default preset chosen beyond the first six;
the dropdown lists the existing bounded 24-preset catalog.

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
`sessionChatMedia` bridge operation. Inline Codex/native/MCP image results join the
answer, while Markdown image paths resolve through the same selected-session
owner. Binary image data never enters the transcript preview or triggers its raw
output overflow control. Ordinary shortened text keeps the full-content reader.

`SessionChatMedia` owns the latest 12 image references in the mounted transcript,
three concurrent reads, a 48 MiB source budget, cancellation and stale-selection
rejection. It supplies the existing Markdown resolver; loading/read/decode errors
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
and documents as named cards with Copy path. Media reads select a recorded item
and attachment ID, validate signatures, and confine real paths to that session's
upload directory. Video data is limited to MP4/WebM/Ogg; codec failures remain
readable. The desktop CSP permits local data media, with no external media hosts.

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
draft entry without overwriting another session. Up to five transcript snapshots
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

The production timeline has one recent-work budget across alternating messages
and tool calls. Running/unknown work and unresolved failures stay outside age
compaction; commentary stays in order. Discovery grouping and completion preserve
inspection. `session-tool-timeline.mjs` exercises these transitions, repeated and
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
