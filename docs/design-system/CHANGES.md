# What changed since the last zip

One change: the cap on working sessions in a task (`TaskGroup`) has a new look and new motion. Archiving from the row is unchanged.

**Remove from the last zip:**

- the ghost row with a pill on it ("⌃ 9 earlier");
- the pill's "⌃ 4 earlier │ ⌄" halves;
- the rows unrolling one by one.

It's all in the components (`bundle.js`, `bundle.css`), the types (`index.d.ts`), the `TaskGroup` and `TaskList` READMEs and the brand book. Try it in the `TaskGroup` card's "A busy task" demo.

## What it looks like now

- **What shows:** a task shows its latest 5 working sessions (`cap`, default 5, a setting). A session that needs you, the open one, and one just started also always show.
- **The earlier ones wait behind one quiet row: "› 9 older".** It's shaped exactly like the "N finished" row: same chevron, 12px, `ink-muted`, 26px high.
- **The first session under that row turns muted** (its title in `ink-muted`), so the list reads as going on above.
  - Mute it with color, never with opacity, so the text stays AA.
  - A session that needs you, or the open one, is never muted.
- **Each click on "› 9 older" brings back the next 5** (`capStep`), not all of them. The count rolls down, and the muted title moves up to the new first row (the old one eases back to `ink`).
- **Show fewer:**
  - while some are back and more are hidden, a quiet "Show fewer" sits at the right of the "older" row (muted 12px text button);
  - once all are back, the row itself reads "⌄ Show fewer" (the chevron turns down).

## The motion: a scroll, not a pop

- **Opening:** the 5 sessions scroll into view from under the "older" row, nearest first, pushing the rest down, as if the list scrolled.
- **How to build it:**
  - each batch is a container whose rows are pinned to its bottom edge (`flex-direction: column; justify-content: flex-end`);
  - animate its `height` in pixels, from 0 to its content height;
  - while it moves: `overflow: hidden`, plus a soft 18px fade on its top edge (a mask);
  - once settled: clear both, so focus rings and hovers aren't clipped.
- **Curve:** `cubic-bezier(0.33, 0, 0.15, 1)` (soft start, long settle).
- **Duration** follows the distance: `clamp(440ms, 320ms + 1.3ms per px, 760ms)`.
- **Measured:** at most about 15px per frame opening 5 rows, and 22px closing 10. No jumps.
- **Set the start height inline before you start the animation.** A Web Animation that hasn't started yet doesn't apply, so the batch flashes open for one frame.
- **Closing:** the same, backwards: the rows scroll up under the "older" row, and the count comes back.
- **Reduced motion:** instant.

## Rules that keep it from jumping

- **A brought-back session stays where it is.** A session that needs you, the open one, or a fresh one is pulled out of the hidden part only while it's still hidden. One you already brought back stays in its place when you open it, or when it starts needing you.
- **After Show fewer, the open session stays in view**, right under the "older" row.
- **Archiving a row inside a brought-back batch** folds it away (the batch's rows are a `MotionList`), and the next older session slides in at the batch's top.
- **Hidden is never finished.** Hidden sessions keep running and keep their status. A filter shows every match, with no cap.

## Accessibility

- The "older" row is a button with `aria-expanded`, and its label reads "Show 5 older sessions (9 hidden)" or "Show fewer sessions".
- It has a focus ring, and so does the "N finished" row now.

## API (unchanged)

- `TaskGroup`: `cap` (default 5; 0 shows all), `capStep` (default 5).
- `TaskList`: `sessionCap`, passed to every task.
