# MachineLaunch

Opening a machine launches it like an app on a phone. The card you picked becomes a box that grows to fill the window; the card's face rides the box and fades out by halfway; the machine's view appears inside the box, scaled to cover it (never stretched); Home zooms in a little and blurs behind. Closing (Change, or leaving the machine) runs the same path backwards and the card lands back in its place.

560 ms to open, 500 ms to close, on one curve (`cubic-bezier(0.32, 0.72, 0, 1)`, fast then soft, like iOS), so the box, the face and the view never drift apart. Under reduced motion it's a crossfade.

**Provide:** `open` (a machine is open), `machine` (its id: the card with that `data-machine` is where it grows from and lands back), `home` (usually a `MachineHome`), and the machine's view (or a `GettingReady` card) as children.

- Do keep the machine's view mounted while Home shows, so the launch has something to reveal.
- Don't animate anything else at the same moment in the window; the launch is the whole story.

The card opens dev-box, then goes back to Home, on a loop. Click any card to open it, and the island to go back.
