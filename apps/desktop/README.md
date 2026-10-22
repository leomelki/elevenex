# Elevenex desktop foundation

The new desktop lives alongside the existing application. Root `pnpm dev` and
the existing frontend/backend/Electron scripts still run the existing app.

**Pending:** supply `docs/design-system/project/README.md` and `tokens.css` from
the design-system zip. The renderer shell and its visual/package verification
must follow that brand book. `dev`, `build` and `package` deliberately report
the missing tokens until those files are supplied.

## Run

Use Node **22.22.3+**, **24.15.0+**, or **26+**. Node 24.12 is too old for this
Angular version. Install with the repository's pinned pnpm:

```sh
pnpm install
pnpm desktop:dev
pnpm desktop:build
pnpm desktop:test
pnpm desktop:lint
pnpm desktop:package
```

The standard names also work from this directory:

```sh
cd apps/desktop
pnpm dev
pnpm build
pnpm test
pnpm lint
pnpm package
pnpm package --mac
pnpm package --win
pnpm package --linux
```

`dev` serves Angular on loopback port 4300 (override with
`ELEVENEX_DESKTOP_PORT`), opens Electron and reloads renderer changes with
Angular HMR. Main/preload/shared changes compile before Electron restarts.
Type errors leave the previous app running. Stop development with Ctrl+C.

`package` builds for the host platform by default. Explicit platform flags
select macOS DMG/ZIP, Windows NSIS or Linux AppImage/DEB. Artifacts go to
`apps/desktop/release/`. Build and test each platform on its own OS; macOS
packaging needs macOS, and cross-platform installers can need additional host
tools. Signing/notarization is separate from this local skeleton.

We use **electron-builder** because its configuration covers all three
requested installer formats and the repository already uses it.

## Layout

| Path | Responsibility |
| --- | --- |
| `apps/renderer` | Angular standalone renderer; no Node, filesystem, git or agents |
| `apps/desktop/src/main.ts` | Windows, trusted IPC, native theme and `app://` |
| `apps/desktop/src/preload.ts` | Sandboxed `window.elevenex` bridge |
| `packages/shared/src/index.ts` | Serializable IPC contracts and bridge types |
| `scripts/desktop-shell.mjs` | Build, development and validation orchestration |

Production uses `app://elevenex/`, with history fallback for routes, confined
asset paths and a nonce-based CSP. Development permits inline CSS for Vite's
style replacement; production permits neither inline scripts nor inline CSS
without its generated nonce. External HTTP(S) links open in the system browser.
App windows deny all permission requests and reject IPC from other origins or
subframes. The preload exposes named methods, never raw Electron objects.

Window state is saved asynchronously in `Elevenex Desktop/window-state.json`
under Electron's application-data directory, separate from the existing app.
Shift+Cmd+N on macOS, or Shift+Ctrl+N elsewhere, opens another window.

## Add an IPC channel

1. Add its argument tuple and serializable result to `InvokeContracts` in
   `packages/shared/src/index.ts` (or a payload to `EventContracts` for events).
2. Add a named method to `ElevenexBridge` and implement it in `preload.ts` using
   the typed `invoke`/`subscribe` wrappers. Event subscriptions return cleanup.
3. Register a main-process handler with `handle(channel, trusted, handler)`.
   Validate every input at runtime; TypeScript cannot validate a compromised
   renderer. Use `broadcast(channel, payload)` for typed main-to-renderer events.
4. Add a contract assertion in `apps/renderer/src/ipc-contract.spec.ts` and run
   `pnpm desktop:test`. This runs both `tsc` (including negative type cases) and
   Angular's default Vitest runner, plus Node tests for the preload and security.

## Design files and fonts

The authoritative tokens belong at
`docs/design-system/project/tokens.css`. Development and production builds copy
that file verbatim to `apps/renderer/src/design-system/tokens.css`; edit the
source, never the copy. Read the adjacent brand-book `README.md`, especially
Motion, before implementing the UI.

Instrument Sans and Geist Mono are bundled in `apps/renderer/public/fonts/`,
with licenses and pinned upstream references. No runtime font downloads are
needed. Theme will follow `prefers-color-scheme` and `data-theme` on `<html>`.
The renderer has no component library, `zone.js`, or `@angular/animations`.

## Checked toolchain

Registry stable tags checked on 2026-10-22: Angular/CLI/build **22.2.3**, CDK
**22.2.4**, Electron **45.0.0**, electron-builder **26.15.3**, ESLint **10.13.0**,
Angular ESLint **22.6.0**, Vitest **5.0.5**, jsdom **30.1.3**. TypeScript **6.0.3**
is the newest stable release in Angular 22's supported range (`>=6.0 <6.1`);
the registry's TypeScript 7 release is incompatible. The existing root pnpm
version is retained to preserve the existing workspace's toolchain.

Angular 22.2.3 bundles an encoder that imports `encodeRangeMappings`, but its
wide source-map dependency range can reuse the legacy app's older encoder.
The root override scopes `@jridgewell/sourcemap-codec` **1.6.0** to this compiler
version so it can load without changing the legacy Angular compiler.
