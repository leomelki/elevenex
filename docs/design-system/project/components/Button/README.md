# Button

The text action: one `primary` per region, `secondary` for the rest, `ghost` in toolbars, `danger` for destructive confirms.

**Provide:** `children` (a verb, sentence case: “Commit”, “New session”), optional `variant` (`primary` · `secondary` · `ghost` · `danger`; default `secondary`), `size` (`md` 30px · `sm` 24px), `icon` / `iconRight` (Icon names), `kbd` (a shortcut hint), and any `<button>` attributes.

- Do lead with the verb; keep labels to one or two words.
- Do put the primary action at the right end of its bar.
- Don't put two primary buttons side by side, except the halves of a split button.
- Don't use `danger` for undoable actions (archiving a session is undoable; discarding changes is not).
