# TaskStage

Where a task is in its life: **Planned** (created, not started), **In progress** (being worked on), **Waiting** (paused on a review, CI, a person, or parked), **Closed** (finished and archived). Tasks use rounded-square glyphs (`StageGlyph`); sessions use circles (`StatusGlyph`), so the two never blur.

**Provide:** `stage` (`planned` · `active` · `waiting` · `closed`). `TaskStage` is the header pill that opens the stage menu; `StageGlyph` (`stage`, `size`) is the bare shape for lists and menus.

- Do move stages automatically when the signal is clear (a session starts: In progress; a PR is opened and nothing runs: Waiting; the PR merges: suggest closing), and let people override.
- Do keep stages neutral in color; urgency belongs to session status, not to the task.
- Don't invent stages per team; map ticket states onto these four.
