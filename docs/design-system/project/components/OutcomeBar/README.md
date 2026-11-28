# OutcomeBar

A turn draws its own footer with the same chips (plus side chat · fork · copy and Review); `OutcomeBar` is the standalone strip for other surfaces, such as a session summary.

What a finished turn left behind, under its answer: the files it changed as `FileChip`s (name first, folder muted, diff), at most three then “+N more”, and one next action (usually Review changes). Chips pop in one after another when the turn finishes; each opens the Changes review (`DiffReview`) at its file. Review opens it at the first file not yet viewed.

**Provide:** `files` (`[{ path, add, del, status }]`), optional `action`, `actionIcon`, `max`.

- Do list files in the order they matter (most changed first), not alphabetically.
- Don't show an outcome bar for turns that changed nothing.
