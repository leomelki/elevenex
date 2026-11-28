# ApprovalCard

The agent is waiting for a yes: run a command, apply an edit, or call a tool. It appears in the chat where the agent stopped, rings twice in `attention` to draw the eye, and the session shows *Needs you* everywhere until you answer. Once answered it collapses to one quiet line (with Undo while the agent hasn't acted yet).

**Provide:** `kind` (`command` · `edit` · `tool`), `command` (or `file` + `diff`, or `tool`), optional `reason` (one line from the agent), `where` (the working folder, short), `status` (`pending` · `approved` · `always` · `denied`), `onResolve(status)`, `onUndo` (false hides Undo).

- Keys: ↵ Approve, Esc Deny, ⌥↵ Always allow; they work from the composer while the card is the latest message.
- Do show exactly what will run, in mono, never a paraphrase.
- Do let “Always allow” remember the exact command (or tool) per project; it shows in Settings.
- Don't stack several pending approvals; the agent waits on one at a time, the next one replaces it.

**Motion:** it rings twice when it arrives; once answered it eases down to its one line (`AutoHeight`), so the chat below glides up instead of jumping.
