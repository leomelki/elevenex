# Sheet

Modal surfaces, and the one motion they share: **the window recedes.** Anything modal sits over the whole window (title bar included) on a light dim, and the window behind steps back: it scales to 98.5%, blurs 3px and loses a little saturation on the launch curve (560ms), and comes forward again on the way out in `dur-slow`. You see you're somewhere else for a moment, and exactly where you'll be put back.

- **`ModalLayer`** (`open`, `onClose`, `align`: `center` · `top`): the layer itself. Clicking the dim or pressing Esc calls `onClose`; it stays mounted while it leaves. Put it inside the `.ex-window`; it recedes that window's `.ex-shell` (`useRecede(on, ref)` does it, counted, so a confirm opened over a sheet keeps the window back until both close).
- **`Sheet`**: a settings-sized panel in a `ModalLayer` at the top, 52px below the window's top edge, so it never tucks under the title bar. A **×** in the top corner closes it, as Esc does. There's no Done or Save: changes in a sheet apply as they're made (Remove and Delete confirm).
  - **One scroll** (`sections`: `[{ id, label, icon, count, content }]`): the sections are listed on the left (under `navHead`), and on the right every section follows in one scroll, each under its label (after `hero`, e.g. a face and a name). The list follows the scroll: its highlight glides (`ease-glide`) to the section you're in, and the last one lights up at the end. A click scrolls there smoothly, and that section stays current until you scroll yourself. `section` sets where it opens, without a scroll animation. Everything is in the page, so ⌘F finds any setting.
  - **Not enough width** (the sheet under 680px, a container query): the list gives way to a tab strip that sticks to the top of the scroll, with the same highlight. Nothing else changes.
  - Without `sections`: your own `nav`, and a body that `page` cross-fades when it changes.
- Building blocks for settings: `SetGroup` (title, a card of rows, a note), `SetRow` (label and sub on the left, the control on the right), `SetField`, `SetChoice`, and `SetValue` (a value that edits in place: plain text with the cue on hover, `well` for commands, `field` to look like a field from the start).

**Where it applies:** sheets (`ProjectSettings`), confirms (`CloseTask`, `DeleteProject`, and any alert). **Where it doesn't:** menus and popovers (they're light and anchored; the window stays put), the side panel, and the two motions that already carry their own: `MachineLaunch` (Home zooms in and blurs behind) and the image lightbox (the image morphs from its place).

- Do open at most one sheet; a confirm can sit over it.
- Don't put work inside a sheet: it's for configuring. Sessions, reviews and the browser live in the window.
- Reduced motion: no scale or blur; the window simply dims.
