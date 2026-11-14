# StatusGlyph

The 14px shape that tells a session's state without relying on color: spinning ring (running), diamond with a bang (needs you), small solid dot (new reply, internal `review`), check circle (done), filled cross (failed), dashed circle (queued).

**Provide:** `status` (`running` · `attention` · `review` · `done` · `failed` · `queued`), optional `size`.

- Do put it first in every session row, mention chip and badge.
- Do let the running ring stop spinning under reduced motion; the ring alone still reads.
- New reply uses a steady 5px accent dot, centered in the glyph box, with the accessible label “New reply”. It represents an unseen agent completion, regardless of file changes; viewing the latest chat clears it. It fades in/out without a burst or spin. First render and reduced motion stay still.
- Other status changes retain their motion: Running → done bursts a ring and draws the check; → needs you nudges; → failed shakes once; other changes swap with a small spin.
- Don't recolor glyphs; each binds to its status token (New reply uses `accent`).
