# Elevenex

If your current setup is part tab cemetery, part terminal zoo, and part "wait, which repo was this note even for?", Elevenex is the cleanup pass. It keeps your terminals, sessions, notes, browser flows, and repo context structured around the actual project they belong to, so you can stay locked in instead of rebuilding your mental state every time you switch tasks.

It is built to replace the usual pile of editor windows, terminal tabs, browser tabs, sticky-note docs, and scattered git tools with one project-centered workspace that does not fry your focus.

## What It Does

- Organizes work as `project -> repo -> branch/worktree -> session`.
- Lets you keep multiple coding sessions open and jump between them without losing context.
- Gives each worktree its own dedicated workspace, so edits, terminal activity, and session state stay attached to the right branch.
- Adds a dedicated Claude Code workspace so AI sessions feel like a first-class part of the app instead of just another terminal tab.
- Brings code editing, terminal access, git context, and browser-based workflows into one place instead of scattering them across five apps.
- Makes it easier to review diffs, manage commits, inspect GitHub state, and stay on top of branch-level work while you code.
- Includes built-in scratchpad and todo panels for the small notes, prompts, and loose ends that usually disappear into tabs or text files.
- Keeps browser-based flows contained inside the app, with isolation designed to avoid leaking the wrong cookies or auth state between contexts.
- Stores workspace state locally so your projects, sessions, and app state remain fast and close to the machine where the work happens.

## Claude Code Workspace

Claude is now a core part of the workspace instead of a raw terminal bolted onto the side.

- Chat with Claude in a cleaner workspace view without losing access to the underlying terminal when you need it.
- Follow long-running work more easily with a readable conversation view, live status, and clearer summaries of what Claude is doing.
- Keep project context closer to the conversation with prompt helpers, skills, and workspace-aware session setup.
- Inspect agent activity, tasks, and connected tools from inside the same session instead of jumping between separate surfaces.

## Browser Isolation

Elevenex also has a built-in browser surface for coding-adjacent flows that do not belong in a terminal or editor tab.

- Elevenex manages isolated browser views inside the app instead of punting everything to an external browser.
- Browser and cookie isolation are part of the design so multiple sessions and embedded tools can coexist without sharing the wrong auth state.

## Architecture

Elevenex is a pnpm monorepo with a desktop shell, a frontend, a backend, and a small layer of custom editor integration.

- `apps/frontend`: Angular application for the workspace UI, session views, Claude workspace, project navigation, GitHub panel, and embedded editor panels.
- `apps/backend`: NestJS backend with REST + WebSocket APIs, Drizzle ORM, `better-sqlite3`, terminal/session orchestration, local persistence, file watching, and supporting app services.
- `apps/electron`: Electron desktop shell that loads the frontend, manages the embedded runtime, owns remote SSH/runtime orchestration, handles packaging, and owns the in-app browser surfaces.
- `vscode-filesystem-provider`: custom VS Code extension that exposes worktree files through backend APIs.
- `vscode-scm-extension`: custom VS Code extension for SCM views, diffs, and quick diff integration inside the embedded editor.

## Build From Source

### Prerequisites

- Node.js with a toolchain capable of building native modules.
- `pnpm` for workspace installs and scripts.
- `claude` available on your `PATH` if you want to use the in-app Claude Code workspace.
- `tmux` recommended for persistent Claude terminal sessions and reconnect behavior.
- Native build support required by dependencies such as `better-sqlite3` and `node-pty`.

If you use remote servers through Elevenex:

- v1 remote auto-install currently supports Linux only.
- The remote server must provide standard POSIX basics such as `sh`, `tar`, `mkdir`, and `ln`.
- Elevenex will check for remote `claude` and `tmux` and pause setup with an in-app SSH terminal if they are missing.
- Elevenex downloads the matching remote backend runtime from CI-built release artifacts, so system Node is not required on the remote host.

### Install

From the repository root:

```bash
pnpm install
```

The root `postinstall` does real setup work:

- builds the custom VS Code integration packages
- syncs bundled VS Code Web extension assets when available
- generates favicon assets from the project logo

### Run In Development

Start the backend:

```bash
pnpm backend:dev
```

Start the frontend:

```bash
pnpm frontend:dev
```

Start the Electron shell:

```bash
pnpm electron:start
```

Start Electron with frontend debug mode:

```bash
pnpm electron:debug
```

Start backend, frontend, and Electron together in a tmux dev session:

```bash
pnpm dev:tmux
```

### Build And Package

Build the macOS package directory target:

```bash
pnpm electron:package:mac
```

Electron packaging now stages two runtime layers:

- the local packaged Electron backend/runtime used by the desktop app itself

## Remote Servers

Elevenex can connect to remote servers over SSH and automatically prepare a remote backend when one is missing or out of date.

- On connect, Elevenex detects the remote OS and architecture.
- v1 supports Linux `x64` and `arm64`.
- Elevenex checks for remote `claude` and `tmux` first.
- If either dependency is missing, Elevenex opens an in-app SSH terminal so you can install the missing pieces and then re-check.
- Once prerequisites are present, Elevenex downloads a versioned runtime artifact to `~/.elevenex`, updates it when the app commit SHA changes, and starts the backend in a detached `tmux` session.
- The remote backend is kept separate from the SSH connection so it survives frontend shutdowns and reconnects cleanly later.

## Database And Schema Changes

Elevenex uses a local SQLite database in the backend, with Drizzle ORM on top of `better-sqlite3`.

- Database schema files live in `apps/backend/src/database/schema/`.
- SQL migrations live in `apps/backend/drizzle/`.
- The backend creates the database and applies migrations automatically on startup.
- For schema changes, run `pnpm drizzle-kit generate` from `apps/backend/` and commit the generated migration file.

Tracked migrations are the workflow here. `drizzle-kit push` is not part of the project flow.

## Project Status

Elevenex is active and evolving. The core workspace model, session UX, editor embedding, terminal plumbing, and local persistence are all present in the repo today.

Some surfaces are still getting polished.

## License

This repository is currently source-available under `CC-BY-NC-4.0`.

That means the code is public and readable, but it is not currently licensed as OSI open source. If you are evaluating the project, check the [LICENSE](./LICENSE) file directly before reuse or redistribution.
