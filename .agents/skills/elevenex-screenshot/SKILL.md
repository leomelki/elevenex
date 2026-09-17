---
name: elevenex-screenshot
description: Capture a real Elevenex UI state in a browser, save the PNG inside the repository, and embed it in chat. Use when the user asks to see how an Elevenex change or screen looks, requests a screenshot, or asks for visual verification of the local app.
---

# Elevenex Screenshot

Use the repository's single-command capture workflow. It handles server reuse/startup,
browser onboarding state, Chrome discovery, transcript positioning, verification, cleanup,
and repository-local output.

## Capture

From the repository root, run one command:

```bash
pnpm screenshot:ui --session <id> --name <short-kebab-name>
```

For the contextual prompt shown while a response is in view, this default command is
enough. It fails instead of silently returning a screenshot without the prompt anchor.

Useful overrides:

```bash
pnpm screenshot:ui --session 213 --name prompt-context --prompt "distinct prompt text"
pnpm screenshot:ui --path /settings --name settings-dark --theme dark --state none
pnpm screenshot:ui --session 213 --name prompt-chat-only --selector .cw-workspace
pnpm screenshot:ui --session 213 --name remote-session --backend-url http://127.0.0.1:45678
```

When the requested state needs interaction, pass an ordered JSON action plan. Prefer stable
attributes and accessible selectors. Add `--verify-selector` for the element the screenshot
is meant to demonstrate so the command fails instead of returning the wrong UI state:

```bash
pnpm screenshot:ui --path /projects --name expanded-sidebar --state none \
  --actions '[{"action":"click","selector":"[data-project-row-id=\"3\"]"},{"action":"click","selector":"[data-workspace-row]","index":0},{"action":"waitFor","selector":".session-create-zone"}]' \
  --verify-selector .session-create-zone
```

Supported actions are `click`, `dblclick`, `hover`, `fill`, `press`, `waitFor`, `wait`, and
`dragTo`. Selectors use Playwright locator syntax. Add a zero-based `index` when a selector
intentionally matches multiple elements. `fill` takes `value`, `press` takes `key`, `wait`
takes `ms`, and `dragTo` takes `source` and `target` selectors with optional `sourceIndex`
and `targetIndex`. Use an explicit `waitFor` on the resulting UI instead of timing-only waits
when possible. The action plan is intentionally declarative; do not add arbitrary JavaScript
or evaluation hooks to capture one-off states.

Run `pnpm screenshot:ui --help` only when an option is unclear. Do not manually start
servers, write ad-hoc Playwright scripts, install a browser, or probe several endpoints
before trying the command. The script explains any missing prerequisite and prints useful
session choices when the requested session is unavailable.

When the relevant session belongs to a backend on a non-default forwarded port, pass its
origin with `--backend-url`. The browser is wired directly to that backend without changing
saved Elevenex environment settings.

The command may need one escalated shell approval because it can bind localhost ports and
launch headless Chrome. Request that approval on the command itself, not through a separate
preflight command.

## Return the image

On success, read the final `SCREENSHOT_PATH=<absolute path>` line. Then:

1. Call the image-viewing tool once with that exact path so the PNG is embedded in chat.
2. In the final response, include the same absolute path and a Markdown image using it.
3. Do not claim success unless the command reports `verified: true`.

Generated PNGs live under `artifacts/screenshots/` by default. That directory is intentionally
gitignored, but it is inside the repository. Pass `--output` when the user wants a tracked
documentation asset elsewhere in the repository.
