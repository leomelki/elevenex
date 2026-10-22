# Markdown

The agent's reply, fully rendered. It's the answer inside a `Turn` (and anything else the agent writes). Everything is shown in full; nothing is clamped.

**Provide:**
- `source`: the Markdown text.
- `resolve(path)`: tells what an embedded file is. Return `{ kind: 'image', src, w, h }`, `{ kind: 'video', src, poster, w, h, dur, marks: [{ t, label }] }` or `{ kind: 'page', title, srcdoc }` (or `url` for a live server), or nothing when the file doesn't exist.
- Optional:
  - `onOpenFile(path)`: a link to a file in the task; open it in Code.
  - `onOpenLink(url)`: a web link; the default opens a new window.
  - `onOpenPage(path)`: a page's "Open in the Browser view".
  - `renderDiagram(source)`: draws a `mermaid` block; without it, the block shows as code.
  - `streaming`: the text is still arriving.

**What it renders**
- **Text:**
  - headings, kept small because a reply isn't a document (17, 15, then 14px, all 600);
  - paragraphs, **bold**, *italic*, ~~struck~~, `code`;
  - lists inside lists, numbered lists, task lists (read-only checks);
  - quotes, callouts (`> [!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]`, `[!CAUTION]`), tables, dividers.
- **Code blocks:**
  - bare wells, with the `code-*` syntax colors for JS and TS (same palette as the Changes review);
  - the language and Copy sit in the block's corner: shown on hover or focus, always on touch screens;
  - Copy turns into a check for a moment;
  - long lines scroll sideways inside the block.
- **Links:**
  - `[text](https://…)` is a web link with a small link mark;
  - `[text](path/in/task.ts)` is a file chip that opens the file in Code.
- **Embeds:** an image line, `![caption](path)`, shows the file itself, by its kind. Image lines that follow each other are one group.
  - **Pictures:**
    - one is a figure, as wide as the reply (at most 380px tall), with its caption;
    - two sit side by side; three or more become a strip that scrolls sideways;
    - two named *before* and *after* become one picture you wipe across to compare (drag, or ← → with focus);
    - clicking a picture opens the viewer: it grows from where the picture sits, ← → steps through the group, Esc or a click shrinks it back.
  - **Recordings:**
    - the poster at the file's size and one play button; nothing plays by itself;
    - quiet controls: play, time, a track you can click, marks from the test's steps (click to jump), speed (1×, 1.5×, 2×), full screen;
    - with focus, Space plays and pauses, ← → jump 5 seconds.
  - **Pages** (an `.html` file the agent made):
    - **Live**, in a sandbox: scripts run, but there's no network, no access to your files and no navigation away.
    - **As tall as the page**, up to 480px. A longer page shows its top with a soft edge and **Show the whole page**, which eases it open; Show less closes it again.
    - **The bar:** the page's name and path, Full width or Phone width (390px), Reload, and Open in the Browser view.
    - **When the agent rewrites the page,** it reloads in place and says *Updated* for a moment.
    - **Far out of view, a page is unloaded.** Its box keeps its size, and the page reloads when it comes back.
    - A page from a live server (`url`) can't be measured, so it sits in a 480px window that scrolls inside.
  - **A missing file** is a quiet chip: “report.html isn't in the workspace”.

**Nothing jumps**
- Pictures and recordings take their final size before they load (from `w` and `h`), then fade in.
- A page starts at its known or default height, then eases to the page's own height once it reports it.
- While `streaming`:
  - text arrives as it does today;
  - an embed appears only once its line is complete;
  - a code block that's still open shows what's there with a caret;
  - a table is drawn once its header row and divider row have arrived.

- Do give every picture and recording its width and height, so its space is reserved.
- Do give every embed a caption: it's the alt text, and the figure's caption.
- Don't let a page reach the network or Elevenex. If it needs data, the agent writes it into the page.
