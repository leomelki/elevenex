# Agent chat UI

Reusable conversation rendering lives here. Session, review, plan, and mission
features own their workflows and compose these pieces.

- `agent-conversation.ts`: one conversation's signals, runtime event reducer,
  history reconciliation, and derived transcript. Instantiate it per chat;
  sharing a singleton would mix independent conversations.
- `agent-chat-connection.ts`: embedded chat subscription, borrowed socket
  lifetime, and coalesced history refreshes. Detached connections ignore late
  responses. The main session workspace owns its reconnect and bootstrap flow.
- `transcript/`: stateless transcript, messages, thinking, turn summaries,
  change panels, and identity/grouping helpers.
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

Reconcile messages by provider identity and content block, preserving repeated
prompts and distinct replies. The narrow legacy recording fallback must stay
within the same user turn; global text deduplication loses legitimate messages.
