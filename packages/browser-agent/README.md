# Browser agent engine

Shared, task-owned JavaScript execution for the desktop and runtime browser MCP.
No Electron or Playwright dependency. The [design and API guide](../../docs/browser-agent.md)
documents research, ownership, limits, transport, recovery and extension points.

- `engine.ts` owns per-conversation workers, deadlines, idle expiry and cleanup.
- `worker-source.ts` defines the JSON-only code realm and async browser facade.
- `broker.ts` validates operations and orders writes on each real tab.
- `target.ts` owns bounded observations, element targeting and captures.
- `cdp-policy.ts` owns the explicit page-method policy.
- `host.ts` defines the privileged adapter boundary; `transport.ts` validates
  private code requests and replies.

Build with the workspace's `pnpm --filter @elevenex/browser-agent build`.
Behavioral tests run through backend Jest; native Electron and Chromium fixtures
exercise both adapters. This package intentionally adds no separate test runner.
