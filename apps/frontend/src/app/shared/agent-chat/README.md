# Agent chat UI

Reusable conversation rendering lives here. Session, review, plan, and mission
features own their workflows and compose these pieces.

- `agent-conversation.ts`: one conversation's signals, runtime event reducer,
  history reconciliation, and derived transcript. Instantiate it per chat;
  sharing a singleton would mix independent conversations.
- `agent-chat-connection.ts`: embedded chat subscription, borrowed socket
  lifetime, and coalesced history refreshes. Detached connections ignore late
  responses. The main session's scoped `SessionRuntime` service owns its
  reconnect and bootstrap flow.
- `transcript/`: stateless transcript, messages, thinking, turn summaries,
  change panels, and identity/grouping helpers.
  `TranscriptViewportDirective` owns scrolling and contextual prompt selection
  for the session, review, and plan chats; DOM updates use `afterRenderEffect`.
- `tools/`: tool presentation, shared file-change parsing, and highlighted diffs.
  Highlighting happens when the relevant content is expanded.
- `composer/`: prompt editing, attachments, queue controls, and draft storage.
- `requests/`: permission and user-input interactions.
- `activity/`: background activity and subagent inspection.
- `markdown/`: sanitized Markdown and local-file link handling. Use
  `AgentMarkdownComponent` to keep document styles and navigation consistent.
- `forked-chat.component.*`: the composed chat used in the review dock, with
  prompt submission delegated to its host.

Keep shared chat code independent of feature internals. Provider protocol types
belong in `shared/models/agent-runtime.model.ts`; the Claude model file only
provides compatibility aliases. A conversation lens hides inherited context and
unwraps prompts when an embedded workflow needs it.

Hosts wire actions explicitly. Enable transcript inspection/review capabilities
only when the host handles their outputs. Keep async results scoped to the
attachment or conversation version that initiated them.

Pass readonly values to transcript inputs. Group related tool state, turn
expansion, and review state with the types in `transcript-view-state.ts`; derive
these groups in host `computed` signals instead of allocating objects in HTML.
Keep actions as explicit outputs rather than passing a mutable conversation or
an untyped options object. The composer uses `model()` for its text value;
hosts that persist drafts can handle `valueChange` explicitly.

Use Tailwind utilities and semantic theme tokens for template-owned layout and
colors. Use the installed Zard buttons and inputs for controls; bind `zDisabled`
on Zard buttons so their native disabled state and appearance agree. The session
status bar uses Zard dropdowns for choices and a popover for usage, with a scoped
dropdown service so an open menu is disposed with its host. Keep custom SCSS for
generated highlighted HTML, animations, container rules, and complex gradients.
Shared attachment cards and setting options own their repeated markup and styles.

Reconcile messages by provider identity and content block, preserving repeated
prompts and distinct replies. The narrow legacy recording fallback must stay
within the same user turn; global text deduplication loses legitimate messages.
