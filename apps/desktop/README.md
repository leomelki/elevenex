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
| `apps/desktop/src/backend` | Release downloads, installation, process supervision and lifecycle IPC |

Production uses `app://elevenex/`, with history fallback for routes, confined
asset paths and a nonce-based CSP. Development permits inline CSS for Vite's
style replacement; production permits neither inline scripts nor inline CSS
without its generated nonce. External HTTP(S) links open in the system browser.
App windows deny all permission requests and reject IPC from other origins or
subframes. The preload exposes named methods, never raw Electron objects.

Window state is saved asynchronously in `Elevenex Desktop/window-state.json`
under Electron's application-data directory, separate from the existing app.
Shift+Cmd+N on macOS, or Shift+Ctrl+N elsewhere, opens another window.

## Local backend

Every launch starts one application-owned backend shared by all windows. The
renderer can open while installation proceeds; closing a window does not stop
the backend while the application is alive. A second app process focuses the
existing instance instead of opening a second database owner.

`~/.elevenex/desktop/` contains:

- `runtimes/<release-tag>-<platform>-<architecture>/`: installed backend and its
  bundled Node executable, plus a completed installation marker.
- `data/elevenex.db`: the new desktop's database, separate from the legacy
  `~/.elevenex/elevenex.db`. Updates replace executable code, never this data.
  App-owned agent workspace, crash logs and model caches also live under `data/`
  through `ELEVENEX_DATA_ROOT`; legacy launchers retain their existing defaults.
  External tools' own authentication/session directories remain in the user's
  home, as they do when those tools run from a terminal.

Build/dev/test compilation stamps `dist/backend-release.json` with the full
source SHA and `runtime-<sha>` tag. For an unreleased checkout, explicitly select
an already published revision when building or developing:

```sh
ELEVENEX_BACKEND_VERSION=<full-40-character-sha> pnpm desktop:dev
```

Release CI can set `ELEVENEX_RELEASE_TAG=runtime-pr-<number>-<sha>` for preview
assets. The tag must match the backend SHA. These are **build-time** inputs;
packaged apps always use their bundled metadata. The app's semver does not need
to change to select a new backend. Repackaging an unchanged backend reuses its
cache. Releases must publish the new
`elevenex-backend-{macos,linux,windows}-{arm64,x64}.tar.gz` asset for each shipped
target, alongside its `.sha256` file, under
`https://github.com/leomelki/elevenex/releases/download/<tag>/`.
The archive must contain `backend/main.cjs` and `backend/node/bin/node`
(`backend/node/node.exe` on Windows). There is no Electron-as-Node fallback;
native dependencies must match the bundled Node, as in the existing release
pipeline. The legacy `elevenex-runtime-*` assets usually omit Node and contain
native modules rebuilt for the old Electron ABI; they cannot run under this app.

`pnpm desktop:backend` bundles the backend and produces the new host-platform
archive and checksum in `dist-runtime/`. It reuses the curated assembly/pruning
scripts with `ELEVENEX_EMBED_LOCAL_NODE=1` and an isolated staging directory under
`apps/desktop/.stage/`. Existing legacy commands retain their original defaults.
Use an official portable Node distribution (as provided by CI's setup-node),
with dependencies installed for that same Node ABI. A Homebrew Node executable
may depend on libraries outside its directory and fail the relocation smoke test.
The runtime CI builds these additional assets alongside remote runtimes; release
manifest validation checks their checksums before publishing. Current CI targets
are macOS arm64, Linux x64/arm64 and Windows x64. Other accepted targets need their
own host build job before an app can be distributed for them.

An installation streams into a private staging directory, enforces download and
expanded-size limits, verifies the release's SHA-256 checksum, and extracts only
regular files/directories with confined paths. PAX and GNU long names are
supported; links, devices and sparse files are rejected. The release pipeline
already dereferences dependency trees. macOS AppleDouble metadata is ignored;
executable permissions are retained without running installer shell commands,
removing quarantine attributes or rewriting publisher signatures. HTTPS and
every redirect are restricted to GitHub's release hosts. Checksums detect
corruption; the publisher and its HTTPS release hosting remain the trust root.

Only after validation is the staged directory renamed into its versioned cache.
A matching completed cache works offline; a missing entry point/executable is
repaired. Failed updates leave previous versions available and report a retryable
failure instead of silently running an incompatible revision. Interrupted staging
directories and older version caches can be removed while the app is closed;
they contain no user data. Previous caches are retained to support app downgrades.

The backend binds to a dynamically allocated loopback port. Startup checks
`/api/info` for the exact expected SHA, with a timeout and cancellation; known
port races and transient Windows executable locks get bounded retries. Its
environment forces loopback/local mode and removes inherited Electron, Node
injection and Elevenex override settings. Process output is drained with a
bounded diagnostic stderr tail. No repository scan or git history reload is
part of this lifecycle.

A small supervisor runs under the bundled Node and treats its IPC connection to
Electron as a lease. Quitting or a parent crash terminates the owned process tree,
with graceful termination followed by a forced stop. No stale PID file can kill
an unrelated process. Backend exit code 75 requests a restart; unexpected exits
also restart with backoff, limited to three restarts per minute. Retry/restart
resets this budget. The supervisor and its process-tree helper are unpacked from
ASAR because plain Node cannot read Electron archives.

The frontend integration boundary is already available, without UI changes:

```ts
const unsubscribe = window.elevenex.onBackendChanged(status => {
  // Show download progress/errors or connect when status.phase === 'ready'.
});
const status = await window.elevenex.backendStatus();
await window.elevenex.retryBackend();   // coalesces with an in-flight startup
await window.elevenex.restartBackend();
// On teardown:
unsubscribe();
```

Subscribe before reading the initial snapshot so a reload cannot miss a phase
change. Only `ready` snapshots carry the current HTTP origin; a restart may
allocate a different port. Future backend transport should respect the existing
renderer security boundary (the production CSP still disallows arbitrary HTTP
connections). The bridge exposes no download URLs, filesystem paths, shell
commands or environment inputs. All backend operations reject extra arguments
and use the same trusted-main-frame validation as the other IPC operations.

`pnpm desktop:test` covers installation/cache/update failures, unsafe archives,
cancelled requests, lifecycle coalescing, runtime revision checks, real child
process startup/shutdown, restart codes, crash cleanup, IPC validation and event
cleanup. The native Electron smoke uses an isolated backend fixture for its IPC
checks; it does not establish a live release download or packaged-app launch.

## Agent UI captures

Use `pnpm desktop:capture` for native Electron screenshots, precise Angular state,
trusted input, layout/focus/accessibility inspection and animation filmstrips.
See [the capture guide](../../scripts/desktop-capture/README.md) for inline scenarios
and warm-server iteration. The shell is still pending; the tool's explicit
`--fixture` mode verifies automation without pretending to be product UI:

```sh
pnpm desktop:capture scripts/desktop-capture/scenarios/check.mjs --fixture
```

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
