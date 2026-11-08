# Browser source inspection

Privileged, framework-aware source resolution shared by Electron's task browser
and the backend's Chromium runtime. This package is outside `shared`: executable
inspection and Node's source-map consumer are runtime behavior, not contracts.
The renderer imports only `BrowserSourceLocation` from `@elevenex/shared`.

`detectBrowserSource(evaluate, selector, pageUrl, current)` takes an already
validated structural selector and a host-owned main-world evaluator. Hosts call
it **only for an explicit human pick**, after the existing opaque-control check.
Agent clicks keep their existing structural-only inspection. `current` must
reject navigation, viewport/driver changes, picker cancellation and disposal;
hosts also reject stale final picks. Nothing runs at page startup or on hover.

The resolver reads the nearest available React development metadata:

- React 18: `_debugSource` file, line and optional column.
- React 19: `_debugStack` frames mapped through the served script's `SourceMap`
  / `X-SourceMap` header or `sourceMappingURL`. Inline JSON maps and external,
  same-origin maps are supported, including bounded embedded indexed sections.
  Generated TSX coordinates are never presented as original source coordinates.

Main-world evaluation is necessary because React's DOM expandos are invisible
in isolated worlds. It runs fixed code in the unprivileged website, with no
preload, Node access, new bindings or CSP changes. It does not invoke components,
install DevTools hooks, patch React, read props/state/text, collect screenshots,
or expose page stacks/source-map bodies to the application renderer or agent.
`sourcesContent` is discarded before mapping. Browser fetches go through the
existing task network policy with credentials omitted and redirects rejected.
There are no privileged network or filesystem reads.

Work is bounded: eight DOM ancestors, forty Fiber hops per ancestor, six metadata
candidates, eight candidate frames per stack, four resource reads per pick,
2 MiB per decompressed resource and 650 ms per browser fetch. Hosts bound CDP
evaluation to 900 ms; a two-second work budget prevents further resource reads.
Each pick owns its resource memoization and fetch deadlines; there is no
persistent cache to grow across HMR updates or survive document changes.

The optional public result is allowlisted again on the remote-to-desktop boundary.
Only canonical source identifiers, bounded positive line/column numbers and
provenance cross it. URLs, query strings, credentials and arbitrary extra fields
are rejected. A location is **page-reported metadata**, never authority to read,
open or execute a file. The human reviews the staged composer context before
sending it. Unsupported or malformed metadata leaves the selector-only flow usable.

Production React builds usually remove this metadata. Other frameworks,
cross-origin frames, shadow roots, inaccessible/CSP-blocked maps, cross-origin
maps, eval/`webpack-internal` scripts without fetchable source, and oversized maps
currently fall back to selector and position. No build plugin is installed into
the inspected project and no paths are inferred by scanning its repository.

The approach was informed by [React Grab's architecture](https://github.com/aidenybai/react-grab/blob/main/packages/react-grab/docs/architecture.md),
[LocatorJS](https://github.com/infi-pc/locatorjs) and
[click-to-component](https://github.com/ericclemmons/click-to-component).
React's private debug fields are intentionally isolated in `src/probe.ts`;
future framework adapters should extend that boundary without changing the
public source contract or importing a browser overlay/telemetry runtime.

`apps/desktop/test/browser-source.test.cjs` covers resolution and resource limits.
The desktop native smoke and backend interaction integration exercise the actual
human picker, separate-world access and source-map handoff. Renderer tests cover
source display, composer staging, missing metadata and conversation changes.
