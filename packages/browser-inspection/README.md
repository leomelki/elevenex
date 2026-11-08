# Browser source inspection

Framework-aware source resolution shared by Electron's task browser and the
backend's Chromium runtime. This package owns executable inspection; `shared`
owns only the serializable `BrowserSourceResolution` contract. The renderer
formats the result without importing the resolver or framework runtimes.

## Supported metadata and precision

| Page/build | Available without changing the page | Exact element locations |
| --- | --- | --- |
| React 18 development | Debug source file/line/column | `_debugSource`, when emitted by the JSX transform |
| React 19 development | Debug stacks with fetchable source maps | Original coordinates from inline/external same-origin maps |
| Svelte 4 and 5 development | Compiler-injected `__svelte_meta.loc` | Element file/line/column, with version-specific coordinate normalization |
| Angular development with class debug info | Component TypeScript declaration | `data-ng-source-location` emitted by a supported compiler's development-only source-location option |
| Vue 2/3 development with SFC filenames | Owning `.vue` component file; no fabricated line | Vue Inspector's `data-v-inspector` marker; Vue Inspector 7's VNode metadata store; hidden `__v_inspector` metadata |
| Other frameworks/custom tooling | No framework-specific inference | `data-elevenex-source` or Code Inspector's `data-insp-path` |

Capability detection replaces version checks. Angular's template markers and
Svelte/Vue private metadata can change; adapters fail independently and preserve
other available metadata. Production builds usually remove framework metadata.
An intentionally emitted source marker remains usable without framework globals.
There is no repository scan, source-text/tag matching heuristic or guessed line 1.

The result distinguishes three cases:

- `source`: a validated file and one-based line, with optional one-based column
  and provenance. `relation: 'ancestor'` explicitly marks a DOM ancestor's location.
- `componentSource`: a component file and framework, with optional declaration
  coordinates. A component declaration is never presented as the selected
  element's template location. Vue's filename-only fallback has no line.
- Neither: selector/position only.

`source` keeps its original required `line` and React provenance values. The
additional kinds, relation and `componentSource` are additive. Older desktops
ignore unsupported optional metadata and retain their picker. The original
`detectBrowserSource` API still returns only exact-location metadata;
`detectBrowserSources` returns the complete resolution used by current hosts.

## Optional development setup

Nothing is automatically installed into or written to the inspected repository.
Existing instrumentation works immediately. Source markers should be emitted
only by a project's development configuration; they disclose source identifiers.

### Angular

For compiler versions that support it (verified with 22.2.3), use a separate
development tsconfig selected by the Angular builder's development `tsConfig`:

```json
{
  "extends": "./tsconfig.app.json",
  "angularCompilerOptions": { "enableTemplateSourceLocations": true }
}
```

This is an internal Angular compiler option, not a stable public API. Keep it
out of the production tsconfig. The compiler emits
`data-ng-source-location="src/checkout.component.html@o:120,l:87,c:2"`;
the adapter converts its zero-based line/column to `88:3`. If the compiler or
flag is unavailable, `ng.getComponent` / `ng.getOwningComponent` plus class debug
info provide the component declaration when available. No `__ngContext__` layout
or private LView offsets are assumed.

### Vue / Nuxt

The SFC loader's `__file` metadata gives a useful component-file fallback. For
exact template coordinates, a project can use its existing
[Vue Inspector](https://github.com/webfansplz/vite-plugin-vue-inspector)
integration. Its standard Vite configuration uses `Inspector()` alongside
`@vitejs/plugin-vue`; follow that project's compatibility/setup instructions.
Elevenex consumes its metadata without invoking its overlay, editor or server.
For Inspector 7, the adapter uses the opaque VNode props identity to look up only
the location tuple in `__vue_inspector_store__.vnodeToPos`. It never enumerates
application props or serializes their values. Legacy visible/hidden markers
remain supported. A plain Vue build without precise instrumentation remains
explicitly component-file-only, including Vue 2 applications still in use.

### Svelte

No additional plugin is needed when the Svelte compiler emits development
metadata. Svelte 4's character-offset-bearing location uses a zero-based line;
Svelte 5's location uses a one-based line. Both use zero-based columns. The
adapter normalizes these differences without an extra network request. Custom
preprocessors must preserve source coordinates or supply explicit source markers.

### Framework-neutral source markers

A build integration can attach one explicit, version-independent location:

```html
<button data-elevenex-source="src/checkout.html:88:3">Pay</button>
```

The contract is `file:line:column`, with positive one-based coordinates. Windows
drive letters and spaces in paths are supported. Code Inspector's
`data-insp-path="file:line:column[:tag]"` is also accepted. The resolver reads
only the four named source-metadata attributes; it does not collect arbitrary
attributes, IDs, text or values. A marker on a DOM ancestor is labelled as such.
The adapter consumes locations only: it never executes callbacks or follows
editor URLs supplied by a page.

## Ownership and security

`detectBrowserSources(evaluate, selector, pageUrl, current)` takes a validated
structural selector and a host-owned main-world evaluator. Hosts call it only
after an **explicit human pick** and the opaque-control check. Agent clicks keep
their structural-only default. `current` rejects navigation, viewport/driver
changes, picker cancellation and disposal; hosts also discard stale final picks.
Nothing runs at page startup or on hover.

Main-world evaluation is required for framework expandos. It runs fixed code in
the unprivileged website, with no preload, Node access, new bindings or CSP changes.
Angular's named read-only debug methods are the only framework functions called.
Components are never invoked; state, props, page text and screenshots are never
collected. Source-map bodies and stacks stay outside the app renderer and agent.
`sourcesContent` is discarded before mapping. Browser resource reads follow the
existing task network policy, omit credentials and reject redirects. There are
no privileged network/filesystem reads and no new application dependencies.

Work is bounded: eight DOM ancestors, forty React Fiber hops and sixteen Vue
owner hops per ancestor, twelve total candidates, eight stack frames per stack,
four resource reads per pick, 2 MiB per decompressed resource and 650 ms per fetch.
Hosts bound CDP evaluation to 900 ms; a two-second resource budget stops further
fetches without discarding already available component metadata. Each pick owns
its memoization and deadlines. No cache/listener grows across HMR or navigation.

The remote-to-desktop boundary allowlists exact and component metadata again,
discarding unknown fields. Only canonical source identifiers and bounded positive
coordinates cross it. Queries, credentials, control characters and traversal
paths are rejected. Source locations remain **page-reported hints**, never file
access authority. The human reviews the composer context before sending it.
Editable controls, cross-origin frames and shadow roots remain opaque. Missing,
CSP-blocked, cross-origin, oversized and eval-only maps retain the ordinary fallback.

## Module boundaries and extension

- `adapters/`: one closure-free discovery function per framework, plus compiler
  marker interoperability. Adapters return only the bounded candidate protocol.
- `probe.ts`: serialized collector, source-attribute allowlist, opaque-control
  gate, ancestor limits and independent adapter failure handling.
- `index.ts`: result precedence, per-pick lifetime and resource budget.
- `resource.ts`: fixed browser fetch with origin, byte, credential and timer limits.
- `source-map.ts`: inline/indexed map decoding through Node's source-map consumer.
- `location.ts`: canonical identifiers and allowlisted public result validation.

To add a framework, add a pure adapter and register it in `sourceProbeExpression`.
Do not add an overlay runtime, global hook or renderer bridge operation. Validate
precision and coordinate conventions against real compiler output, and add
failure/cancellation/compatibility tests. Tests run through the existing desktop
Node suite, backend browser integration suite and Angular runner; native captures
verify source display and human review. Fixtures and per-run evidence live in
ignored `artifacts/`.

References: [React Grab](https://github.com/aidenybai/react-grab/blob/main/packages/react-grab/docs/architecture.md),
[Angular source locations](https://github.com/angular/angular/issues/70927),
[Svelte location emission](https://github.com/sveltejs/svelte/blob/main/packages/svelte/src/internal/client/dev/elements.js),
[Vue Inspector](https://github.com/webfansplz/vite-plugin-vue-inspector),
[Code Inspector](https://github.com/zh-lx/code-inspector),
[LocatorJS](https://github.com/infi-pc/locatorjs).
