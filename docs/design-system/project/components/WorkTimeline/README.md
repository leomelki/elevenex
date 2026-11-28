# WorkTimeline

The chronological story of a turn: agent prose interleaved with compact tool
activity. Nonempty agent messages delimit sections. When the next message
arrives, the preceding section folds into an expandable summary where it
happened: “5 reads · 3 commands · 2 edits”, with an icon per category. Prose remains visible in
completed history, so the summary explains the work between messages.

**Provide:** readonly `steps`, `live`, `expanded`, `maxVisible` (default 5 recent
steps in the active section), and optional `answer`, `answerId` and
`answerBeforeStepId`. Active sections remain fully visible until they exceed
twice `maxVisible`, then summarize older steps under an “Earlier” lead and
retain the latest window.
Empty streaming replies do not close a section. Completion closes trailing work.

Each summary opens independently. Its native button retains identity and keyboard
focus through expansion, collapse and new messages, with `aria-expanded` and an
accessible Show/Hide activity name. Counts describe tool operations; commands do
not imply file reads or edits. Category labels stay readable alongside their icons
and wrap as complete items on narrow layouts.

Failed calls fold into the summary with a red shared status glyph and explicit
“1 failed” count. This count is a subset of the activity totals, which count
attempts rather than successes. Failure-only sections still show an expandable
summary. Expected/recovered failures do not contribute to the failure marker.
Running/unknown tools, inspected results and focused content stay visible. Explicit collapse releases a section’s inspection pins. Later
success never implies recovery: supply `recovered` or `expected` explicitly.

**Motion:** flat keyed rows retain the tool and Markdown instances, including
open output and copy controls. Fold controls visibility in place, with immediate
inertness for closed content. New rows grow before their ink appears; saved
history stays still. A closing section's step and summary swap in the same row
on one shared curve, so its height holds and the swap crossfades. AutoHeight owns output/reasoning growth. All transitions
are interruptible and respect reduced motion.
