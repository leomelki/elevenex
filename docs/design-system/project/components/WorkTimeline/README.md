# WorkTimeline

The chronological story of a turn: agent prose interleaved with compact tool
activity. Nonempty agent messages delimit sections. When the next message
arrives, the preceding section folds into an expandable summary where it
happened: “Read 5 files · Ran 3 commands · 2 edits”. Prose remains visible in
completed history, so the summary explains the work between messages.

**Provide:** readonly `steps`, `live`, `expanded`, `maxVisible` (default 5 recent
steps in the active section), and optional `answer`, `answerId` and
`answerBeforeStepId`. Active sections remain fully visible until they exceed
twice `maxVisible`, then summarize older steps and retain the latest window.
Empty streaming replies do not close a section. Completion closes trailing work.

Each summary opens independently. Its native button retains identity and keyboard
focus through expansion, collapse and new messages, with `aria-expanded` and an
accessible Show/Hide activity name. Counts describe tool operations; commands do
not imply file reads or edits. Summaries wrap on narrow layouts.

Running/unknown tools, unresolved failures, inspected results and focused content
stay visible. Explicit collapse releases a section’s inspection pins. Later
success never implies recovery: supply `recovered` or `expected` explicitly.

**Motion:** flat keyed rows retain the tool and Markdown instances, including
open output and copy controls. Fold controls visibility in place, with immediate
inertness for closed content. New rows grow before their ink appears; saved
history stays still. AutoHeight owns output/reasoning growth. All transitions
are interruptible and respect reduced motion.
