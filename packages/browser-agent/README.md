# Browser agent engine

Task-owned JavaScript execution and real Playwright for desktop Electron and
runtime Chromium. Read the [architecture and API](../../docs/browser-playwright.md)
and [design research](../../docs/browser-agent.md).

- `engine.ts` owns per-conversation code workers, deadlines and idle expiry.
- `worker-source.ts`, `realm-data.ts` and `playwright-facade.ts` define the code
  realm and its JSON-only, opaque-handle facade. Closures stay in that realm.
- `playwright-worker-client.ts` owns the separate Playwright worker and live
  browser-session leases in main. `playwright-worker-host.ts` proxies those fixed
  capabilities. Main can revoke/clean up a lease while Playwright is unresponsive.
- `playwright-broker.ts` delegates public methods to pinned Playwright objects;
  `playwright-policy.ts` defines membership, `playwright-routes.ts` bridges route
  predicates and callbacks, `playwright-http.ts` confines Node-side HTTP to the
  task proxy, and `artifacts.ts` owns private paths and file budgets.
- `playwright-transport.ts` virtualizes an in-memory browser containing only
  authorized task pages. `protocol-lease.ts` aborts paused requests before detach;
  `nested-session.ts` scopes runtime frame/worker sessions without private APIs.
- `interactions.ts` and `interaction-controller.ts` own durable human requests;
  the picker runs in a separate worker with an explicit human/document lease.
- `broker.ts`, `target.ts` and `cdp-policy.ts` retain first-version code helpers.
- `host.ts` defines privileged adapters; `transport.ts` validates wire payloads.

Build with `pnpm --filter @elevenex/browser-agent build`. The existing esbuild
embeds the trusted worker so ASAR/backend bundling does not depend on an adjacent
worker file. Playwright and its assertions remain external runtime packages and
are included in desktop/remote staging. No browser is launched by this package:
Elevenex owns the task profile and supplies only private page connections.

Behavioral tests run through backend Jest. Real Chromium, native Electron, MCP
SDK, runtime archive and renderer capture tests exercise separate boundaries.
