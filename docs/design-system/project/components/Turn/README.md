# Turn

One agent reply, in the chat's reply column: the agent's mark sits in a narrow 28px gutter (its tooltip names the agent and the time), and everything it says starts at one left edge. Top to bottom, always: **work line → thread → answer → what it changed**.

The renderer accepts an optional `harness` ID for the shared bundled logo
(Claude Code, Codex, OpenCode or Pi). `ReplyMark` draws every agent on the same
28px tinted tile: peach/terracotta for Claude, periwinkle with an app-inspired
gradient for Codex, and a neutral tint with `ink` for OpenCode/Pi. The shared
`AgentMark` balances each logo's optical size and uses theme-aware `harness-*`
tokens. The `mark` monogram fallback (missing or unknown ID) uses the neutral
tile and `ink-muted`. Brand colour identifies the harness; the live teal ring
remains a separate activity signal and stops under reduced motion. `author` is the
harness display name ("Claude Code", not its ID) and the tile's `img` name. The
same treatment applies to standalone agent `Message`s.

**While it works:** the mark breathes; the work line reads *Working · 1m 12s · 5 steps* with a Stop chip. Below it the thread (`WorkTimeline`): what the agent says between steps as prose in ink, the steps under it as small muted rows, condensed to recent completed work with one turn-wide budget (“N earlier steps” for older tools). Commentary remains in place. Running tools stay in their chronological rows; thinking shows the thought's title and reasoning through `NowLine`. The latest reply remains visible as it streams. A line runs down the gutter beside the thread.
**When it finishes:** the work line crossfades to **Worked 4m 12s**, the mark's ring lets go, untouched work folds away, inspected or explicitly opened work keeps its current window, the answer completes and the footer opens: the files it changed as `FileChip`s, then side chat · fork · copy (on hover or focus) and Review. The facts behind the work line (“Edited 3 files +92 −12 · 200/200 passed · Ran 1 command”) fade in one by one when you hover or focus the reply, and stay while its thread is open; unresolved failures always show; on touch screens they always show. Click the line to unfold the thread.
**Stopped / failed:** *Stopped after 1m 2s* (with Continue) or *Failed after 2m* (in `danger`, with the error and Retry).

**Provide:** `status` (`live` · `done` · `stopped` · `failed`), `steps` (`[{ kind, detail, status, meta, dur, diff, output, hunk, recovered, expected, result, text, title, stream }]`; kinds: `think` (with `title` and `text`), `say` (what the agent writes between steps, in `text`; `note` is the older name), `read` `search` `list` `edit` `create` `run` `test` `tool` `web` `ask`), `duration` (seconds), `elapsed` (live), `outcome` (`{ files, action }`; Review is shown when files changed), `error`, `open`, `maxVisible`, `onStop` (false hides the chip), `author`, `mark`, `time`, and the answer as children.

**Motion:** nothing pops. New thread rows grow in; tools and results retain their row through every handoff; the reply eases to its height as it streams; on finish everything above happens together and eases.

**Send handoff (renderer extension):** `isNew` opts a newly mounted reply into
the sent bubble's entrance. Working follows by 80ms, gliding up 12px and fading
over 340ms on `ease-glide`; the small agent mark springs from 86% on `ease-spring`.
Reserve the reply's layout immediately so the bubble's landing position does not
move. Saved receipts and streamed content do not restart entry. History is still;
reduced motion fades for 160ms without travel, scale or delay. Focusing a control
settles the entrance immediately.

- Do keep the answer the most visible thing in a finished turn; the work is evidence, one hover or click away.
- Do give each thought a short title; it's what the now line and the thread show.
- Do keep unrecovered failures visible in `danger`; recovered ones live only in the thread, struck through with “fixed”.
- Don't render the turn somewhere else when it finishes; it folds in place.

**Out of reach** (`reach: { machine, since }`): while its machine can't be reached, a live turn stops moving (in an `.ex-offline` window) and one line folds open under it: "**Out of reach since 14:02.** It keeps running on dev-box; what it did shows up when it's back." When it's back, the steps it took meanwhile grow in.
