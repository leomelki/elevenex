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
