# CommitPanel

What you see before a commit. Pressing **Commit** grows a panel out of the button, right under it. You type a message (or don't) and press ↵.

```
┌ ⊸ Describe the change, or leave it to Elevenex        ┐
│ 47 files +2201 −553   14 staged · 33 unstaged       ⌄ │
│   ⌕ Filter 48 files                                   │
│   ☐ A .env.local            ⛉ may hold secrets  +31 −11│
│   ☑ M web/src/components/Badge.tsx              +91 −21│
│   … the 4 biggest changes                              │
│   Show the other 43                                    │
│ ☑ Include 34 unstaged files                            │
│ ⛉ .env.local may hold secrets, so it’s left out. Include it │
│ ◌ Write the e2e test is still running. What it changes │
│   from now on won’t be in this commit.                 │
│ ───────────────────────────────────────────────────── │
└ ◯ Push after                          [Commit 47 ↵]   ┘
```

## How it works

- **The message comes first, and it's optional.** The focus lands in it. Leave it empty and Elevenex writes it after you press Commit. The placeholder never shows a draft, because there is none yet.
- **Everything is included by default**, staged or not. One checkbox, “Include 34 unstaged files”, keeps only the staged ones. With nothing unstaged, the checkbox isn't there.
- **The files stay folded behind one line:** the count, the lines, and how many are staged and unstaged. Click it to open the list.
- **The list stays short.** It never takes more than 6 rows (28px each):
  - a filter on top;
  - what needs a look (a file that may hold secrets);
  - the 4 biggest changes;
  - “Show the other 43”. The rest then scrolls in the same 6 rows, so the panel doesn't grow. Its bottom edge fades while there's more below.
  - Typing in the filter searches every file, with the count of matches on the right.
  - In staged-only mode, the files it can't pick go last, dimmed.
  - A row: a checkbox, the status letter, the folder muted and the name in ink, a “may hold secrets” tag when it applies, and the line counts. Rows don't say “unstaged”: the summary line counts them, and staged only sets them apart. Hover a row to see whether it's staged.
- **A file that may hold secrets is left out**, with one line: “.env.local may hold secrets, so it’s left out. Include it”. Include it flips to “Leave it out”. The line folds away in staged-only mode, where the file is left out anyway.
- **Running sessions get one line**, never a guess per file: “Write the e2e test is still running. What it changes from now on won’t be in this commit.”
- **Push after** turns the button into “Commit and push”. The button shows how many files go in.
- **↵ in the message, or ⌘↵ anywhere, commits.** Esc, a click outside, or the Commit button again closes it untouched, and the focus goes back to the button.

## After Commit

The panel folds back into the button, and the button carries on in place:

1. “Writing the message…” (only when the message was left empty). Pass it to `GitBar` as `busyLabel`, with `busy: 'commit'`.
2. “Committing…”.
3. The next step: Push, or Commit 1 when a file was left out.

## Motion

- **Open:** the dialog morph (`useMorphFrom`, the same as ModalLayer `from`) on the launch curve, 560ms. The box grows from the button's rect to its place under it, fading in over the first 30% while the button stays visible underneath. It doesn't carry a copy of the button: a button stretched to a panel's shape looks wrong. The content fades in once there's room.
- **Close:** the same, backwards, 500ms, into the button. The panel fades out as it reaches the button, so the button's new label (“Writing the message…”) shows through.
- While it closes, it keeps showing what it showed, even if the files change as the commit starts.
- Opening the list folds it open (`Fold`). “Show the other N” and filtering ease the list's height (`AutoHeight`).
- Reduced motion: a short fade.

## Layout

- 460px wide at most (the header's width minus 24px), right-aligned to the GitBar, 8px under the button.
- Padding 12px. Everything inside starts 22px from the edge: the message icon, the summary, the filter icon, the checkboxes, the notes and the switch. On the right, the line counts, the chevron and the links end 22px from the edge, and Commit ends 12px from it.
- Message 40px high, the summary line 32px, rows 28px, the option 32px, notes at least 28px, then a divider and the footer (30px buttons).

## Use

Render it as GitBar's `panel`. It finds its button and its header itself.

```js
h(GitBar, { files: 48, add: 2232, del: 564, busy: state.busy, busyLabel: state.writing ? 'Writing the message…' : null, onCommit: toggle,
  panel: h(CommitPanel, { open: isOpen, files, running: ['Write the e2e test'], push, onPush: setPush, onClose: close,
    onCommit: function (c) { /* c.message === '' → write it first */ } }) })
```

**Provide:** `open`, `files` (`{ path, status, add, del, staged, flag: 'secrets' }`), `running` (session names), `push`, `onPush`, `onClose`, `onCommit({ message, files, push })`.

- Do keep the list folded when it opens. Most commits need only the count.
- Do keep the list at 6 rows. Anything that needs a closer look goes to the Changes view.
- Don't guess which files a running session is editing. Say once that it's running.
