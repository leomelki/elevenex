# Motion

How Elevenex moves. Motion explains change (where a thing came from, where it went, what's alive), and never makes you wait.

**Principles**
1. **Never wait on motion.** Input is never blocked; every animation can be interrupted. Enter at the token time, exit at about two thirds of it.
2. **Small distances, a little playful.** 4–8px moves, 0.94–0.97 scale. Things that travel glide on `ease-glide` (a real spring, ≈4% overshoot, over `dur-glide`); small marks pop on `ease-spring` (≈12%); surfaces never bounce. Presses go down instantly and spring back.
3. **Alive while working, still when done.** Running work moves calmly (the spinning ring, a light sweep on a running step, a blinking caret); finished things stop.
4. **Optimistic first.** Show the result at once (a new task row, a sent message), reconcile quietly; skeletons only after 150ms.
5. **Only what changed.** History never animates on load: lists add `ex-live` to their container after first paint, so only rows, glyphs and messages that arrive later animate.
6. **Cheap to run.** Transform and opacity only; thumbs and indicators move with `transform`; panels use the View Transitions API.
7. **Nothing pops, nothing jumps.** Nothing appears or disappears in one frame, and nothing below it is shoved: `Fold` opens in place, `AutoHeight` eases swaps, `MotionList` grows rows in and collapses them out, `Presence` lets things leave. A wrapper added for motion never changes layout.
8. **Reduced motion means no movement.** Under `prefers-reduced-motion`, movement and loops stop; changes still crossfade at once.

**The vocabulary** (all in `bundle.css` and the bundle's `play` / `useFlip` / `Presence` / `FlipScope` helpers): menus and popovers spring from their anchor; dialogs pop a touch slower (`dur-slow`, no overshoot) and, like sheets, recede the window behind them (`ModalLayer`); thumbs, the rail indicator (which stretches as it travels) and picker highlights glide on the spring; tab labels un-blur in while the other tabs slide aside; status glyphs play their change (burst, nudge, shake); presses spring back; the switch knob stretches while held; your sent message springs up; new items flash once; rows reveal and stagger 24ms apart (max 6); messages rise 8px; streamed words fade over `dur-slow`; numbers roll; checks draw themselves (`dur-deliberate`); approvals ring twice in `attention`; toasts rise and count down; switching session or project crossfades the main area with a 6px lift. In the sidebar (`FlipScope`), the selection glides from row to row, a task that changes stage travels to its group and folds there, finished sessions slide into “N finished”. The title island springs its width and height to its new content while the words blur in. Opening a machine grows its card into the window (`MachineLaunch`, 560ms, the one motion past `dur-deliberate`).

The first cards show a turn from start to finish (it thinks, talks, acts, then folds), the four no-pop tools, opening a machine, the sidebar moving as one surface and the title island; the rest show the vocabulary. The demos are live. The decisions behind them (springs vs curves, how bouncy, FLIP vs width, no pointer-following highlight, no confetti, no typewriter) are in the brand book under Motion decisions.
