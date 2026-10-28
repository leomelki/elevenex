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
