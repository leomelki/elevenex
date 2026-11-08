# WorkTimeline

The story of a turn. What the agent says between steps (`say`) is prose in ink; the steps under it are small muted rows, so reading only the prose tells you what happened and the rows show how. Reads, searches and listings that happen back to back collapse into one row (“Read 3 files, searched 1 time”) that expands to the list; a thought is a row “Thought · <title> 9s” that expands to its reasoning; edits show their diff and expand to the hunk; commands and tests show their result and expand to the output.

**Provide:** `steps` (see `Turn`), `live`, `expanded`, `maxVisible` (one recent-work budget, default 4 entries; discovery groups count as one entry; older completed work folds into “N earlier steps”, never for a single step), `maxVisible`.

**Motion:** rows are a `MotionList`, keyed by their first step: new ones grow in (height first, then ink), condensed ones fade and collapse, and a read that becomes “Read 3 files” updates in place.

- Do strike through a failed step the agent recovered from, tagged “fixed” (or what fixed it); keep unrecovered failures in `danger`; tag deliberate failures “reproduced”.
- Do show durations only for steps over a second.
- Don't show raw tool names or JSON; say what happened in a verb and a target.

The timeline is chronological around the latest reply (`answer`, `answerId`,
`answerBeforeStepId`). Every message keeps the same Markdown behavior, and every
tool keeps its mounted identity. Commentary is never silently removed by the
recent-work budget. Running/unknown steps, unresolved failures and inspected
results remain visible. A discovery group formed around an inspected member
stays open and keeps focus on that member.

The earlier-work control remains mounted after reveal and becomes “Show fewer
steps”; its width and text ease in place. Explicit collapse releases inspection
pins. Live and completed work use the same budget, so completion cannot expand
an opened history. Fold controls group members in place instead of moving them
to another list. New rows grow in before their ink appears; existing history
never replays entry. All transitions are interruptible and respect reduced motion.
