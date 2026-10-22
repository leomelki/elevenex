# ProjectMark

A project's face: its own logo when it has one, otherwise a two-letter monogram on its identity hue. Used in the rail, the sidebar header, task rows in the all-projects view, and pickers.

**Provide:** `name`, and `logo` (an image URL; square, at least 72px, SVG or PNG) or `initials` + `hue` (`ocean` `pine` `plum` `rust` `steel` `rose`), optional `size` (36 rail, 20 headers, 16–18 rows and pickers), `decorative` (true when the name is written next to it).

- Do let people upload a logo per project; fall back to the monogram, never to a generic icon.
- Do show the logo as given, full-bleed in its rounded square; transparent logos sit on `surface-raised` with a `line` edge.
- Don't recolor or crop a logo to fit the palette.
- The logos in these previews are placeholders, not real projects' marks.
