# TurnNav

A slim map of the session's turns at the right edge of the chat, for long sessions: one short bar per turn, wider for the one in view. Bars are `review` when the turn changed files, `attention` when it needs you, `running` while live. Hover a bar to see the prompt; click to jump.

**Provide:** `turns` (`[{ id, label, meta, state: 'changes' | 'attention' | 'live' }]`), `active`.

- Do show it only from five turns up; shorter sessions scroll fine.
