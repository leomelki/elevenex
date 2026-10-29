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
fork, side-chat and queue edit/reorder controls. File links request the Changes
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


## Designed composer

The connected chat now uses `Composer`’s Plan/Code switch, agent chip and
permission picker directly. Harness, model, thinking and fast mode live inside
the agent popover; the toolbar stays on one row. All choices use authoritative
state with busy/error handling, retain the draft, and reject archived/historical
edits. An accepted harness change returns focus to the composer, guarded by the
selected scope/task/session identity. Queue removal/steering restores composer focus before a row disappears.
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
Live context/token values come from the selected session; plan display remains an
optional supplied-data UI capability. The menu’s snapshot stays mounted through
its inert exit. The dedicated `/agent-picker` preview and `agent-picker.mjs`
verify the full reference component independently of transcript motion.
