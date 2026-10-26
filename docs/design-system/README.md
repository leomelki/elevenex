# Elevenex design inputs

Read [CHANGES.md](CHANGES.md) first for the latest archive changes.

The brand book, tokens and component specifications in `project/` were supplied
in `elevenex-design-system-standalone.zip`. They are kept here so the component system has
durable design inputs. Reference React code and gallery build tools are not part
of the application runtime.

`project/tokens.css` is the authoritative source consumed by desktop commands.
The generated `apps/renderer/src/design-system/tokens.css` is ignored by git and
must not be edited. Font files and their licenses are bundled in the renderer.

See [renderer architecture and usage](../../apps/renderer/README.md) for the
Angular port, interactive preview and platform adapter boundaries.

The 2026-10-24 update imports the changed brand/component specifications and the
new JobBrief, NewProject, ProjectMenu, ProjectSettings and Sheet specifications.
Tokens are unchanged. Reference React/gallery code stays in the supplied local
extraction; the application uses Angular components and the bundled fonts.
See [the implementation review](../../apps/renderer/DESIGN_REVIEW.md) and
[native verification](../../apps/renderer/VERIFICATION.md) for the updated scope.

The later 2026-10-24 ZIP replaces RunChoice with AddMachine/MachineAdd and moves
first-launch download/connection/installation progress onto Home's machine cards.
MachineLaunch now waits for readiness, anchors to the visible card and holds Home
still. ModalLayer gains a trigger origin. The changed MachineCard, MachineHome,
MachineLaunch, GettingReady, NewProject and Sheet specifications plus the brand
book/index were imported verbatim; obsolete RunChoice documentation was removed.
This archive contains 3 added, 3 removed and 21 modified files (including generated
gallery/reference files). The Angular runtime ships none of the reference React.
Both token files are unchanged. The comparison is preserved locally in
`elevenex-design-system-update.local/latest-files.json` and `latest.diff`.

The 2026-10-25 ZIP changes 7 files: the brand book, AddMachine/Sheet specifications,
design index, and reference CSS/JavaScript/types. Its anchored ModalLayer now uses
a launch-style box/face/content/shadow morph (560ms open, 500ms close), replacing
the scale-from-trigger animation. The four changed vendored specification/index
files were imported verbatim. Tokens, dependencies and other component specs are
unchanged. The archive comparison is in the ignored local `oct25-files.json` and
`oct25.diff`; reference runtime files remain outside the Angular application.

The 2026-10-26 ZIP adds the archive's `CHANGES.md` and updates 22 files. Its
seven changed component specifications, brand book, design index and reference
`index.d.ts` are imported verbatim. Tokens are unchanged. Reference JavaScript,
CSS and galleries remain in the ZIP/local extraction, outside the Angular runtime.
The comparison is in the ignored `elevenex-design-system-update.local/oct26-files.json`.
The Angular port adds later-project rail insertion, card preparation errors and
Home island actions to the existing component and production machine flow.

The next 2026-10-26 ZIP adds MachineMenu and EditMachine (85 gallery cards).
Read the updated CHANGES.md for the card menu, editing, removal/Undo and Toast
actions. The changed brand book, design index, types and five component specs
are imported verbatim. Tokens are unchanged. Archive comparison preserves local
documentation customizations for unrelated components. The Angular production
machine owner implements local/SSH editing, native identity selection,
reconnection, removal and Undo; reference React stays outside the application.
