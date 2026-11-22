# Elevenex

Development targets the Angular renderer in `apps/renderer` and the Electron
shell in `apps/desktop`. The previous frontend in `apps/frontend` and its shell
in `apps/electron` are slated for removal. See the [desktop setup guide](apps/desktop/README.md).

If your current setup is part tab cemetery, part terminal zoo, and part "wait, which repo was this note even for?", Elevenex is the cleanup pass. It keeps your terminals, sessions, notes, browser flows, and repo context structured around the actual project they belong to, so you can stay locked in instead of rebuilding your mental state every time you switch tasks.

It is built to replace the usual pile of editor windows, terminal tabs, browser tabs, sticky-note docs, and scattered git tools with one project-centered workspace that does not fry your focus.

## What It Does

- Organizes work as `project -> task -> session`. Repositories belong to projects.
- Lets you keep multiple coding sessions open and jump between them without losing context.
- Creates named tasks for implementation, investigation, or review, starting from a new branch or an existing local or remote branch.
- Chooses a clean environment automatically, keeping concurrent tasks isolated. Task names can change independently of their branches.
- Finishes and reopens tasks without losing their branches or conversations. Checkouts with local edits remain reserved; clean managed checkouts can be reused.
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

Elevenex is a pnpm monorepo.

- `apps/renderer` owns the Angular workspace UI, routing, and view state.
- `apps/desktop` owns the Electron shell, the typed preload bridge, local and remote backend connections, and OS integration.
- `apps/backend` owns the NestJS REST and WebSocket APIs, project and task data, Git, files, terminal processes, and agent sessions.
- `packages/shared` defines serializable domain types and IPC contracts.

## Build From Source

### Prerequisites

- A supported Node.js version and a toolchain capable of building native modules. See the [desktop setup guide](apps/desktop/README.md#run).
- `pnpm` for workspace installs and scripts.
- Git 2.25 or newer on each backend host; see [Git compatibility](docs/git-compatibility.md).
- `claude` available on your `PATH` if you want to use the in-app Claude Code workspace.
- Native build support required by dependencies such as `better-sqlite3` and `node-pty`.

Local backends launch terminals and actions directly with `node-pty`; they do
not detect, require, or invoke `tmux`. Remote POSIX backends use `tmux` to keep
processes alive across SSH disconnects and backend restarts.

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

Start Electron, the Angular dev server, and the checkout's local backend from
the repository root.

```bash
pnpm desktop:dev
```

To work on individual renderer components, start the component preview and
open `http://127.0.0.1:4310`.

```bash
pnpm desktop:preview
```

The root `pnpm dev`, `pnpm dev:tmux`, `pnpm frontend:*`, and `pnpm electron:*`
commands target the legacy app.

### Build And Package

Build and package the desktop from the repository root.

```bash
pnpm desktop:build
pnpm desktop:package
```

For platform targets and backend runtime packaging, see the [desktop setup guide](apps/desktop/README.md).

## Remote Servers

Elevenex connects over SSH and prepares a versioned backend with bundled Node
on supported Linux and macOS hosts. For host requirements and backend
lifecycle, see the [remote development guide](apps/desktop/REMOTE_DEVELOPMENT.md).

## Paired Desktop Port Forwarding (legacy frontend)

When connected to a paired desktop, open a project's **Port forwarding** tab and
choose **New forward**. Enter the service's port and save; Elevenex forwards it to
the same port at `127.0.0.1` on your computer using the existing encrypted link.
No SSH credentials or additional router setup are needed. **Copy local address**
puts the host and port on your clipboard. Forwarding carries TCP traffic, including HTTP,
HTTPS, WebSockets, and database connections; UDP is not supported.

**Advanced settings** let you use a different local port when one is occupied or
change the remote host and port. Local listeners stay on loopback. `localhost`
on the paired desktop reaches both IPv4 and IPv6 services. Active forwards keep
their local ports through connection loss and resume when the desktop reconnects;
existing connections need to reconnect. Stopping a forward or disconnecting the
desktop releases its local ports and connections. Definitions are saved per
project and paired desktop, with a prompt to start them again after reopening.
Both desktops need a version of Elevenex that supports port forwarding.

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
