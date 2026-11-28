# NowLine

What the agent is doing this second: a running ring, the action in a verb and its target, its live meta (“143 / 200”) and time, an optional progress line along the bottom, and a light sweep. When the action changes, the new one rolls up into place. While the agent thinks, it reads “Thinking · <title>” and shows the last lines of the reasoning, fading at the top; the reasoning folds away when thinking ends.

**Provide:** `kind` or `verb`, `detail` (mono target) or `title` (a thought's title), `text` (reasoning, while thinking), `stream` (type it out, for demos), `meta`, `elapsed` (seconds), `progress` (0–1).

- Do show it only while a turn is live, as the last thing above the streaming reply; `Turn` holds it 700ms between two actions so it doesn't flicker.
- Don't show it for actions under 400ms; they'd only flicker.

Inside a `Turn`, it's the thread's next row: its icon sits on the steps' icon column, its verb on their text column, 4px under the last row, with the thread's line running down to it.
