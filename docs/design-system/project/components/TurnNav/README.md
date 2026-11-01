# TurnNav

A slim map of the session's turns at the right edge of the chat: one short bar per turn, wider for the one in view. Bars are `review` when the turn changed files, `attention` when it needs you, `running` while live. Hover a bar to see the prompt; click to jump.

**Provide:** `turns` (`[{ id, label, meta, state: 'changes' | 'attention' | 'live' }]`), `active`.

- Show it from the first turn so navigation stays available in every session. Hide it only when there are no turns.
