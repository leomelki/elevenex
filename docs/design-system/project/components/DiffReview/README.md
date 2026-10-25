# DiffReview

The Changes view: a task's changes reviewed like a pull request. One long scroll goes through every changed file. Each file shows its hunks with three lines around them, and you can open more context above or below any hunk. The file list takes you to any file, and marking a file **Viewed** folds it away. **Full files** shows each file whole with its changes marked in place, like an editor's inline diff. Changes is the default.

**Provide:** `files` (`[{ path, status, add, del, oldPath?, binary?, viewed?, rev? }]`; status `M`, `A`, `D` or `R`) and `loadFile(path)`, which returns a promise of `{ old, new }`. The list (paths, status, counts) is known at once, for example from git's numstat. Each file's lines are fetched when it comes near (see Loading). A file can also carry `old` and `new` directly. Optional: `mode` (`'changes'` | `'full'`) with `onMode`, `wide` (otherwise it's wide from 720px), `wrap` (default on), `context` (default 3), `largeAt` (default 400 changed lines), `onViewed(path, on)`, `onComment({ path, line, side, text })` (`false` hides the line +), `onOpenFile(path)`, `onExit` (Esc), `controller` (a ref that gets `goTo(path)`, to open the review on a file from the chat), `toolbarEnd`.

**Layout**
- **Narrow (the side panel, 440px):** the toolbar has the current file (`client.ts 1 of 5`, which opens the file list), previous and next file, the viewed ring (`2/5`), **Changes | Full**, and wrap. There's one gutter: the new line number, or the old one, dimmed, on a removed line. Long lines wrap and hang under their first line.
- **Wide (Wider review, or 720px and up):** the file list becomes a column on the left, grouped by folder, with the current file's highlight gliding as you scroll. There are two gutters, old and new.
- **Each file** is a card with a single `row-height` (32px) header: collapse chevron, status letter, bold filename with muted inline folder, counts and independent **Viewed** / Open in Code controls. The chevron gets the collapse hover fill; the whole filename area stays clear. Updated files have a labelled attention glyph in the row. While pinned, the header sits flush under the toolbar with square top corners and a quiet lower shadow, then is pushed out by the next file. Narrow rows keep the Viewed checkbox and accessible label while hiding its visible word.
- **Hunks** are separated by a sunken row with the hunk position (`@@ −54,8 +55,13 @@`) and the function it sits in. Its buttons show 20 lines above, 20 below, or all of a gap of 20 lines or fewer. At the top of a file there's only "above"; at the end there's only "more lines".
- **Lines** use the code type, the `diff-*` grounds with + and − signs (never color alone), the `code-*` syntax colors, and the changed words inside a changed line on `diff-*-strong`.
- **The overview ruler** on the right edge maps the whole scroll. It shows each change (added, removed, or both as a split mark), a tick per file and where you are. Click it to go there.
- **Deleted files** say so and show their lines on request. Very large changes wait behind **Load the diff**. Binary files are named, not shown.

**Wider review: the panel takes over the chat**
- The expand icon in the panel header (⇧⌘R) lets the Changes panel take over the chat's place for a while. The task sidebar and the rail stay. The panel eases wide over where the chat was (`dur-slow`, `ease-in-out`) while the chat fades. The chat stays laid out at its own width while it goes, so nothing in it reflows. The review switches to the wide layout in the same motion, and back the same way: the file column, the second gutter, the gap buttons and the line notes all ease with the panel over the same `dur-slow`. Nothing waits for the panel to finish or to cross a width, and you keep the line you were reading. Give `wide` as a boolean here: left to the width, the column would only follow once the panel crossed 720px, which is a second step.
- The same icon (now shrink), or Esc, brings the chat back the same way. A question you sent about a line goes to the session as usual. When the agent answers while the chat is covered, a dot appears on the shrink icon.
- It's not full screen: the window's chrome, rail and sidebar never move. `usePanelTakeover(on)` returns the ref for the main area and sets `is-takeover` on the shell.

**Loading: lines arrive as you scroll**
- The list, counts and file headers are there at once. A file's lines are fetched when the file comes within about two screens of the view, closest first, three at a time. Viewed and collapsed files aren't fetched until you open them.
- Until its lines arrive, a file shows a quiet skeleton about the height it will have, estimated from its counts. The scroll, the overview ruler and jumps hold still, and a small ring in the header shows it's loading.
- When the lines arrive in view, the skeleton eases to the real height and the lines fade in. Out of view, the swap is instant.
- **What you're reading never moves.** Whatever changes above it (a file arriving and growing or shrinking, a file folding, context opening) is absorbed by the scroll: the line at the top of the view stays at the same spot. It works like the browser's scroll anchoring, but it knows about the sticky headers.
- **Jumping to a file that hasn't loaded** goes there at once (no long smooth scroll over skeletons), fetches it first, and holds it at the top while files above it arrive. It fades in from 6px. Your own scrolling releases the hold.
- If a file fails to load, its body says so, with **Try again**. When the agent changes a file, its `rev` changes, its lines are fetched again, and if you had viewed it, it opens with **Changed since viewed**.

**Reviewing**
- **Viewed** folds the file to its header and fills the ring. If you mark it from inside a long file (its header stuck at the top), the body fades, the scroll moves to the file's start (where the header looks the same), and the body folds with the next file rising under it. Nothing jumps.
- **If the agent edits a file you viewed,** it opens back up with **Changed since viewed** (`attention`), and the file list shows a dot.
- **Ask about a line:** hover a line and press +. A small box opens under it, and ⌘↵ sends the text to the session with the line attached. The sent note stays on the line.
- **Keyboard** (with the review focused): ⌥↑ ⌥↓ previous and next file, V viewed, F7 / ⇧F7 next and previous change, Esc closes the list or menu.

**Motion, and nothing jumps**
- Opening context **above** a hunk keeps the hunk where it is on screen: the new lines grow upward and the scroll follows. Opening context **below** grows downward, just under where you were reading. Both ease their height (`dur-slow`, `ease-in-out`). When a gap is fully open, its row folds away.
- Switching **Changes ↔ Full files** (or wrap) keeps the change you were reading at the same height on screen, and the stream fades in softly around it.
- **Folding a file only moves what you can see.** The part of a file below the view is trimmed at once (or added at once when opening), so a 2,000-line file folds over the same short distance as a short one. The time follows that distance (150–260ms closing, 200–340ms opening). Closing, the lines lift 8px and fade on `ease-in` while the box closes on `ease-in-out`, and the header's bottom corners round once it has closed. Opening is the reverse, with the lines settling in from −8px. The header you clicked stays where it is and only what's under it moves. From inside a long file (header stuck), the lines fade, the scroll moves to the file's start, then it folds into the header.
- Opened context and line notes grow in over a time that follows their height, and their lines settle in the same way.
- The viewed check springs in, the ring's arc eases, and its count rolls. The ruler's marks glide when the layout changes. The wide layout's column eases open with the panel.
- First paint never animates. Under reduced motion everything applies at once.

- Do give `add` and `del` with the list, so the skeletons are the right size and the counts never change when the lines arrive.
- Do keep Changes as the default view and Full files one click away; Full files is for reading a change in its whole file.
- Do let a viewed file stay viewed until the agent changes it again.
- Don't color-code alone: the + and − signs, the status letter and the Viewed text carry the meaning too.
- Don't truncate code: lines wrap (or scroll sideways with wrap off); nothing is clamped.
