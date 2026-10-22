# GitBar

Git in the task header, as **one button for the next step**:

- **Uncommitted changes:** the lines changed (+214 −38, it opens the Changes view) and **Commit 7**, the number of changed files on the button (⌘↵ opens an inline, agent-drafted message).
- **Everything committed, commits waiting:** just **Push 2**; the count on the button says what's waiting.
- **Up to date:** just “Up to date”; no button.
- **While it runs:** the button reads “Committing…” or “Pushing…” with a running ring, and the agent keeps working beside it.

The chevron holds the combinations for the current step. On Commit: Commit and push, Push the commits already waiting (when there are some), Commit and open PR, Sync with main. On Push: Push and open PR, Push to a new name, Sync with main.

**Provide:** `files` (uncommitted changed files), `add`, `del`, `ahead` (commits not pushed), `busy` (`'commit'` · `'push'`), `onCommit`, `onPush`, optional `compact`.

- Do keep it in the task header, right-aligned; it's the only place git verbs live.
- Don't show a disabled button for a step that doesn't apply: the bar shows only what you can do now.
- Don't block the agent while committing or pushing.

**Motion, and no layout shift:**
- The bar is right-aligned with a flexible space before it, so when it changes size only that space gives: the title, branch and links never move.
- The button is one element the whole time. Going from Commit to Committing…, or Push to Pushing…, its icon and label crossfade in place (`EaseSwap`): the old one fades up and out first, then the new one blurs in from below, so two labels never blur over each other. Meanwhile the button's width eases to the new label. Nothing is unmounted and nothing snaps.
- The button and the stat each sit in a slot that only animates when it appears or leaves. **Appearing** (nothing to do → something to commit): the space opens while the pill grows out from the right with its rounded edge, empty; once it's mostly open, its icon, label and count fade in, drifting the way it opened. Text is never shown cut by a hard edge. **Leaving**: the reverse, with the label fading out first, then the empty pill retracting and dissolving. Sizes use `dur-slow` on `ease-in-out` (plain easing, never a spring). A closing slot keeps its last content, and a hidden slot's content takes its new size at once, so the slot opens straight to the right width.
- Counts use fixed-width digits and roll when they change.
- Measured frame by frame through seven state changes (edits → committing → 1 to push → pushing → up to date → new edits → committed again → 3 to push): the button is never replaced, its own width moves at most 4px in a frame, the title and right edge never move, and the bar's left edge glides (at most 14px in a frame at 120 fps) with no jump at the end.
- Checked with frozen filmstrips, 20ms apart: appearing and leaving both end exactly where the settled layout is (no snap when the slot goes back to auto width).
