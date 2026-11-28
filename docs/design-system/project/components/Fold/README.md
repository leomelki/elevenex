# Fold

Show and hide anything whose height you don't know: the grid row eases from 0 to its content (`dur-slow`, `ease-in-out`) while the content settles from −4px and fades in. Closing is quicker (`dur-base`): the content lifts and fades on `ease-in` before the row has closed, so expanding a thread, a step, a group or a step of New task never jumps. Content stays mounted, so state inside is kept. It clips only while moving or closed: once open and settled, focus rings and hover fills spill out. Closed content is `inert` (can't be tabbed into), and the column is `minmax(0, 1fr)`, so long rows still truncate.

**Provide:** `open`, `className`, children.

The card also shows the other tools that keep things from popping (all in the bundle):
- **`AutoHeight`**: a box that eases to its content's height when the content swaps or grows (a card collapsing to one line, a reply streaming). Small steps are followed as they come; content is never delayed. Props: `className`, `innerClassName` (give it the parent's layout, e.g. its gap), `duration`.
- **`MotionList`**: a keyed list whose new rows grow in and removed rows fade then collapse. Props: `items` (`[{ key, node }]`), `as`, `itemAs`, `className`, `exit`.
- **`useHold(value, ms)`**: the last non-empty value, held for `ms` after it empties; bridges the gap between two actions.

- Do give a wrapper the layout of what it wraps (gap, direction); motion must never change layout.
- Don't animate history: content that's there on first paint renders folded or open, without a transition.
