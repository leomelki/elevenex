# GitBar

Git in the task header, as **one button for the next step**:

- **Uncommitted changes:** the lines changed (+214 −38, it opens the Changes view) and **Commit 7**, the number of changed files on the button. Pressing it opens a `CommitPanel` out of the button (an optional message, the files, Commit), passed as `panel`.
- **Everything committed, commits waiting:** just **Push 2**; the count on the button says what's waiting.
- **Up to date:** just “Up to date”; no button.
- **While it runs:** the button reads “Committing…” or “Pushing…” with a running ring, and the agent keeps working beside it. Before Committing…, `busyLabel` can say “Writing the message…” when the message was left empty.

The chevron holds the combinations for the current step. On Commit: Commit and push, Push the commits already waiting (when there are some), Commit and open PR, Sync with main. On Push: Push and open PR, Push to a new name, Sync with main.

**Provide:** `files` (uncommitted changed files), `add`, `del`, `ahead` (commits not pushed), `busy` (`'commit'` · `'push'`), `busyLabel`, `onCommit`, `onPush`, `panel` (the `CommitPanel`), optional `compact`.

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

**On a sub-task** (`mergeInto`, the parent's branch): the way back is a merge, not a push.
- With changes, the button commits as usual (its menu offers Commit and merge).
- Once committed, the next step is **Merge into flaky-checkout**: the merge icon, no count. Its title says how many commits.
- The chevron has Squash and merge (the default), Merge commit, Rebase on the parent, and Push this branch.
- While it runs, the button says **Merging…**. When it's done:
  - the sub-task's branch and workspace go away;
  - its sessions move into the parent's history;
  - you stay where you were; the session you're in now belongs to the task (its header becomes the task's), and messaging it again carries on, on the task's branch;
  - a toast says what merged, with Undo. No session gets a line, and no other session is told anything: Elevenex never messages or interrupts sessions on its own. If a running session in the task is editing the same files, the merge waits for it.
- A conflict opens a card instead, in the session where you pressed Merge (Let the agent resolve it, Open in Changes). Nothing merges until it's clean.

**Jobs** (`job`): merging, syncing and pushing are jobs Elevenex runs itself, and the button is their home while they run.
- **The label is the step:** “Merging · 2 of 4”, or the current step's short name (“Merging · resolving 3 conflicts”), with a running ring. The stat and the counts step aside.
- **Its menu lists the steps** (click the button or the chevron): each with its glyph, a detail, and who does it. Steps are what Elevenex can know for certain: commits synced, files in conflict, the command it runs and how long it has run. A step only shows progress (like 41 / 78) when the command reports it; otherwise elapsed time.
- **When the job needs judgement**, Elevenex starts one session for it (a `SessionRow` with `kind: 'auto'`, ⚡, opening on a `JobBrief`). The step names it, with a chip that opens it. You aren't moved there; a `Toast` says it started, with Open.
- **When that session needs you**, the button reads **Merge waiting on you** in `attention` and opens the session.
- **Done:** the job leaves the button (it eases back to Push or Up to date) and a toast says what happened, with Undo.
- Cancel stops the job and puts the branches back as they were.

**Provide (job):** `{ verb, noun, title, steps: [{ status, label, detail, short, session }], waiting, open, note, onOpen, onCancel }`.
