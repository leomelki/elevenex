# ThinkingBlock

The model's reasoning as a standalone block, for surfaces outside a turn (a side chat, a log). Inside a `Turn`, thinking is part of the thread instead: a `think` step with a title, shown live in the `NowLine` and as “Thought · <title>” once done.

While it thinks, the label shimmers and a timer runs; when it's done it becomes one quiet line, “Thought for 12s”, that unfolds the reasoning on click (a `Fold`, so nothing below jumps).

**Provide:** `active`, `seconds`, optional `open`, the reasoning as children.

- Do keep it collapsed by default; people open it when they want the why.
- Don't show a thinking block for turns under a second.
