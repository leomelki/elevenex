# MachineLaunch

Opening a machine launches it like an app on a phone. It only ever launches a machine that's ready: anything that waits waits on its card on Home first (`MachineCard`'s `busy`), and the launch starts a moment after the card says it's ready (about 450 ms: the dot settles, the line changes), so you see what it's opening. The card you picked becomes a box that grows to fill the window; the card's face rides the box and fades out by halfway; the machine's view appears inside the box, scaled to cover it (never stretched); Home zooms in a little and blurs behind. Closing (Change, or leaving the machine) runs the same path backwards and the card lands back in its place.

560 ms to open, 500 ms to close, on one curve (`cubic-bezier(0.32, 0.72, 0, 1)`, fast then soft, like iOS), so the box, the face and the view never drift apart. Home zooms in around the card's center and blurs behind, so the card stays put while everything else grows past it. Under reduced motion it's a crossfade.

**Every launch, the same way:**
- **From the card, where you see it.** The card's place on screen is read while rendering the update that opens, before the commit can move it (a regroup, a reflow, a zoomed frame), so the box always grows out of the card you clicked. It never starts from the middle.
- **Home holds still meanwhile.** `MachineHome` knows its window has a machine open (it reads it from `MachineLaunch`): nothing moves on it, and a machine that just connected keeps its group until Home shows again. Closing lands the card where it now is.
- **Only from a card at rest.** Open a machine only once it's ready: the card stops getting ready, its dot settles and its line says so, then launch about 450 ms later. Never launch from a card that's still getting ready.

**Provide:** `open` (a machine is open), `machine` (its id: the card with that `data-machine` is where it grows from and lands back), `home` (usually a `MachineHome`), and the machine's view as children (on a machine with no project, `NewProject` over the app out of focus).

- Do keep the machine's view mounted while Home shows, so the launch has something to reveal.
- Don't animate anything else at the same moment in the window; the launch is the whole story.


The card plays the first launch (Home's first run: This Mac getting ready, a server added from its dashed card, whatever you open launching once ready; the island points at the card it's about) and a later one (a machine that isn't connected getting ready on its card, then launching; the island goes back to Home, then offers Back to that machine, and opens Find at rest).
