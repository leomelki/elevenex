# Elevenex design inputs

The brand book, tokens and component specifications in `project/` were supplied
in `elevenex-design-system.local`. They are kept here so the component system has
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
