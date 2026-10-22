# ComposerQueue

Messages typed while the agent was running wait here, above the input, and go out in order when the current turn ends. Each one can be **steered** (sent now, read at the agent's next step without stopping it), edited or removed.

**Provide:** `items` (`[{ text }]`). The `Composer` renders it when it gets `queue`.

- Do keep it inside the composer card; it disappears when the queue is empty.
- Do steer with ⌥↵ straight from the input, without queueing first.
- Don't reorder silently; dragging a row reorders the queue.
