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
