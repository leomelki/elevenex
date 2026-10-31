# Connected session chat

`SessionChatComponent` is the production adapter for a selected
`{ scopeId, taskId, sessionId }`. It composes the conversation family's public
components; those components remain independent of the bridge and providers.
`MachineWorkspace` provides the chat client and drafts at workspace lifetime,
so nested/preview backend scopes resolve consistently.

- `SessionChatClient` calls only named, scope-bound bridge operations. Main owns
  HTTP, credentials, validation, coalescing, deadlines and cancellation.
- `SessionChatStore` owns one visible transcript window, long reads, mutation
  epochs and feedback. It cancels reads on navigation, hiding or destruction.
  Pending writes can finish on their original backend; their replies never
  change a different conversation. No write is replayed by reconnect or refresh.
- `SessionChatDrafts` retains at most 20 ordinary session drafts per workspace
  scope. Unresolved writes are not evicted silently. A failed send restores its
  text ahead of any newly typed draft. An uncertain outcome requires checking
  delivery and explicit acknowledgement before another send.
- `session-chat-transcript` projects provider-neutral items into stable turns,
  pairing tools/results by tool ID and preserving commentary, reasoning,
  unknown tools, orphan results and explicit failures. Fresh prompts alone opt
  into entry motion; initial history stays still.
- Codex history restores native command, patch, MCP and web-search receipts with
  the live stream's tool IDs. Code-mode `exec` envelopes are omitted when native
  receipts supply the work, retaining separate output and exit/error status for
  each tool. Envelopes without supported native receipts remain inspectable.
- `SessionChatContent` reads original long messages, tool input and output in
  16,000-character pages. Its modal owns focus and cancellation. Content is
  rendered as text, including HTML returned by tools.

The backend adapter supports the registry's Claude, Codex, Pi and OpenCode
providers, with its existing prompt/queue/steer/stop semantics. Questions include
Claude's permission-backed AskUserQuestion and provider-native questions/MCP
primitive form fields. Permission decisions target the actual pending request;
one-shot requests omit Always allow. Model/permission choices come from runtime
capabilities. Activity exposes reported subagents, background tasks, hooks,
notifications, retries, limits and context usage. Archived sessions are read only
and load persisted history without attaching a runtime.

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

The integration deliberately hides unavailable attachment, dictation, mention,
fork, side-chat and queue edit/reorder controls. File links request the selected reply’s Changes
panel; external HTTP(S) links use the existing main-process navigation policy.
Media resolution, subagent transcript navigation and richer MCP schemas remain
separate integrations. The desktop connection layer and legacy app are unchanged.

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
assistant text. Tool results remain paired with their original calls; late
receipts do not move those calls past the reply. Earlier commentary and tools
retain source order as subsequent replies arrive. `session-work-order.mjs`
checks this ordering, tool/work disclosures, top hover/focus summaries, keyboard
operation and narrow reduced-motion layouts in both themes.


## Designed composer

The connected chat now uses `Composer`’s Plan/Code switch, agent chip and
permission picker directly. Harness, model, thinking and fast mode live inside
the agent popover; the toolbar stays on one row. All choices use authoritative
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
new controls. File attachments, mentions, dictation and preset/fork integrations
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
selected choice stays local until creation. No default mutation happens
while editing this form.


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
