# Session workspace

The workspace component owns its inputs, layout, drawers, and host outputs.
Three component-scoped services own the conversation workflows:

| Owner                   | Responsibility                                                                                                    |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `SessionRuntime`        | Conversation state, provider/settings commands, authentication, bootstrap, sockets, reconnection, history refresh |
| `SessionDraftContext`   | Draft persistence, attachments, session mentions, worktree context and prompt submission                          |
| `SessionMessageActions` | Forks, rewind/edit, plan review, turn expansion, review threads and agent inspection                              |

These services are provided on the component, so mounted session tabs have
independent state and cleanup. Drafts depend on runtime; message actions depend
on runtime and drafts. Runtime does not depend on either of the other owners.

The component binds its input signals once through `SessionWorkspaceInputs`.
The owners read those signals directly; input values are not mirrored into
another store. `linkedSignal` handles the two values that can change locally
after an input establishes their initial state. `ngOnChanges` delegates the
connection transitions to runtime, while typed local lifecycle notifications
coordinate draft restoration and action resets. External host events are
forwarded with `outputFromObservable`.

Conversation mutations go through owner commands. The shared `AgentConversation`
keeps protocol state, reconciliation, and transcript derivation in one place;
display aliases are readonly. UI components receive readonly view state and
emit actions explicitly. Avoid passing these feature services into shared UI.

Scope asynchronous responses to the conversation and request version that
started them. A stale response must neither apply data nor clear a newer
request's loading state. Owners release subscriptions, timers, and editor or
socket resources through `DestroyRef` and `takeUntilDestroyed`.

Scrolling is shared with embedded chats through `TranscriptViewportDirective`.
The composer owns textarea sizing; both update rendered DOM with
`afterRenderEffect`. Keep session workflow logic out of these shared DOM owners.
