# StatusGlyph

The 14px shape that tells a session's state without relying on color: spinning ring (running), diamond with a bang (needs you), half-filled circle (review), check circle (done), filled cross (failed), dashed circle (queued).

**Provide:** `status` (`running` · `attention` · `review` · `done` · `failed` · `queued`), optional `size`.

- Do put it first in every session row, mention chip and badge.
- Do let the running ring stop spinning under reduced motion; the ring alone still reads.
- Do let the glyph play the change: it remembers its last status. Running → done or review bursts a ring and draws the check; anything → needs you nudges; → failed shakes once; other changes swap with a small spin. First render never animates.
- Don't recolor glyphs; each binds to its status token.
