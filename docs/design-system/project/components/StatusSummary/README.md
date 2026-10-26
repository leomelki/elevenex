# StatusSummary

Four counters atop the sidebar (needs you, running, review, done) that double as filters: “what needs me” is one glance and one click away. Wire `active` and `onSelect` to `TaskList`'s `filter`: choosing Needs you folds away every task and session that doesn't need you; choosing it again brings them back.

**Provide:** `counts` (`{ attention, running, review, done }`), optional `active` (the status filter on) and `onSelect(status)`.

- Do order it attention → running → review → done, always.
- Do show zero counts, muted, so the layout never shifts.
- Don't add more counters; failed sessions count under “needs you”.
