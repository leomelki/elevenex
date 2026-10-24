# ProjectMark

A project's face: its own logo when it has one, otherwise a face on its identity hue: two letters, an emoji or an icon. Used in the rail, the sidebar header, task rows in the all-projects view, and pickers.

**Provide:** `name`, and either `logo` (an image URL; square, at least 72px, SVG or PNG) or a face on a `hue` (`ocean` `pine` `plum` `rust` `steel` `rose`): `initials` (two letters), `emoji` (one emoji) or `icon` (a name from the icon set). Optional `size` (36 rail, 20 headers, 16–18 rows and pickers), `decorative` (true when the name is written next to it).

- The face is picked when the project is made (`NewProject`, step 3 Look) and changed in its settings. Letters come from the name; the hue starts as one picked from the name until someone chooses.
- Order of precedence: `logo`, then `emoji`, then `icon`, then `initials`.
- Do let people upload a logo per project; fall back to the face, never to a generic icon.
- Do show the logo as given, full-bleed in its rounded square; transparent logos sit on `surface-raised` with a `line` edge.
- Don't recolor or crop a logo to fit the palette.
- The emoji is the one place the interface shows an emoji: it's the person's choice of face, not decoration.
- The logos in these previews are placeholders, not real projects' marks.
