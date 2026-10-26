# Turn

One agent reply, in the chat's reply column: the agent's mark sits in a narrow 28px gutter (its tooltip names the agent and the time), and everything it says starts at one left edge. Top to bottom, always: **work line → thread → answer → what it changed**.

**While it works:** the mark breathes; the work line reads *Working · 1m 12s · 5 steps* with a Stop chip. Below it the thread (`WorkTimeline`): what the agent says between steps as prose in ink, the steps under it as small muted rows, condensed to the latest message plus the last four steps (“N earlier steps” for the rest). Then the `NowLine` with the action in progress (while it thinks: the thought's title and the last lines of its reasoning), then the reply as it streams. A line runs down the gutter beside the thread.
**When it finishes:** the work line crossfades to **Worked 4m 12s**, the mark's ring lets go, the thread folds away, the answer completes and the footer opens: the files it changed as `FileChip`s, then side chat · fork · copy (on hover or focus) and Review. The facts behind the work line (“Edited 3 files +92 −12 · 200/200 passed · Ran 1 command”) fade in one by one when you hover or focus the reply, and stay while its thread is open; unresolved failures always show; on touch screens they always show. Click the line to unfold the thread.
**Stopped / failed:** *Stopped after 1m 2s* (with Continue) or *Failed after 2m* (in `danger`, with the error and Retry).

**Provide:** `status` (`live` · `done` · `stopped` · `failed`), `steps` (`[{ kind, detail, status, meta, dur, diff, output, hunk, recovered, expected, result, text, title, stream }]`; kinds: `think` (with `title` and `text`), `say` (what the agent writes between steps, in `text`; `note` is the older name), `read` `search` `list` `edit` `create` `run` `test` `tool` `web` `ask`), `duration` (seconds), `elapsed` (live), `outcome` (`{ files, action }`; Review is shown when files changed), `error`, `open`, `maxVisible`, `onStop` (false hides the chip), `author`, `mark`, `time`, and the answer as children.

**Motion:** nothing pops. New thread rows grow in; the now line holds 700ms between two actions instead of collapsing and reopening; the reply eases to its height as it streams; on finish everything above happens together and eases.

- Do keep the answer the most visible thing in a finished turn; the work is evidence, one hover or click away.
- Do give each thought a short title; it's what the now line and the thread show.
- Do keep unrecovered failures visible in `danger`; recovered ones live only in the thread, struck through with “fixed”.
- Don't render the turn somewhere else when it finishes; it folds in place.
