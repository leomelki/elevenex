# LinkChip

A task's link to a pull request or a ticket: an icon, the key in mono (`#482`, `PAY-212`) and its live state. A task can be linked when it is created, linked later (paste a URL or key), or never linked at all.

**Provide:** `kind` (`pr` · `ticket`), `label`, `state` (PR: `draft` · `open` · `approved` · `failing` · `merged` · `closed`; ticket: its tracker's status as text), optional `href`, `compact` (key only, for sidebar rows).

- Do show at most one PR and one ticket per task in headers; extra links live in the task's details.
- Do let a merged PR prompt closing the task (the chip turns `accent`, the header offers “Close task”).
- Do offer “Link PR or ticket” as a quiet ghost when nothing is linked; never nag, never require it.
- Don't show provider logos; the icon says PR or ticket, the key says which.
