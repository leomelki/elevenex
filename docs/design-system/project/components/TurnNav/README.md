# TurnNav

A slim map of the session's turns at the right edge of the chat: one short bar per turn, wider for the one in view. Bars are `review` when the turn changed files, `attention` when it needs you, `running` while live. Hover a bar to see the prompt; click to jump.

**Provide:** `turns` (`[{ id, label, meta, state: 'changes' | 'attention' | 'live' }]`), `active`.

- Show it from the first turn so navigation stays available in every session. Hide it only when there are no turns.
- Keep a compact window of up to seven comfortable markers, capped at 40% of the chat's height. More messages scroll within that window rather than making the rail taller or shrinking hit targets. Virtualize the marker list for large histories.
- Follow the message being read while idle. Pause following while the pointer or keyboard is browsing the rail; browsing alone never scrolls the chat. Fade the edges to suggest continuation, and reveal position and scrollbar on hover/focus.
- Arrow keys, Page Up/Down and Home/End browse. Enter/Space jumps. Keep one Tab stop and stable focus through virtual row changes. Hover previews identify each prompt, its position and status.
