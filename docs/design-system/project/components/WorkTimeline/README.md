# WorkTimeline

The story of a turn. What the agent says between steps (`say`) is prose in ink; the steps under it are small muted rows, so reading only the prose tells you what happened and the rows show how. Reads, searches and listings that happen back to back collapse into one row (“Read 3 files, searched 1 time”) that expands to the list; a thought is a row “Thought · <title> 9s” that expands to its reasoning; edits show their diff and expand to the hunk; commands and tests show their result and expand to the output.

**Provide:** `steps` (see `Turn`), `live` (condense: the latest message stays, plus the last `maxVisible` steps, default 4; earlier rows fold into “N earlier steps”, never for a single row), `maxVisible`.

**Motion:** rows are a `MotionList`, keyed by their first step: new ones grow in (height first, then ink), condensed ones fade and collapse, and a read that becomes “Read 3 files” updates in place.

- Do strike through a failed step the agent recovered from, tagged “fixed” (or what fixed it); keep unrecovered failures in `danger`; tag deliberate failures “reproduced”.
- Do show durations only for steps over a second.
- Don't show raw tool names or JSON; say what happened in a verb and a target.
