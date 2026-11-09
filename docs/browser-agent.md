# Code-first browser MCP

## Design and research

The browser is a programmable task resource. An agent should complete an entire
known workflow in one call, keep useful working state, and choose when text or
images are worth returning. Human takeover must revoke observation and control.
Local and remote tasks use the same programming surface.

Research reviewed on 2026-11-09:

| Project | Useful idea | Application here |
| --- | --- | --- |
| [T3 Code tools](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/mcp/toolkits/preview/tools.ts) and [broker](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/mcp/PreviewAutomationBroker.ts) | Shared human/agent tabs, bounded snapshots, explicit ownership, desktop/server routing | Task/session-scoped capabilities; agent observations require ownership; common engine with two host adapters |
| [Codex / ChatGPT browser](https://learn.chatgpt.com/docs/browser?surface=app) | Integrated visual verification, separate browser profiles, native input and page inspection; full CDP is a distinct capability | Task profiles remain separate from the user's regular browser; screenshots are first-class MCP images; protocol scope is explicit |
| [Playwright MCP](https://github.com/microsoft/playwright-mcp) | Accessibility targeting; its README recommends CLI/skills for coding agents to reduce schema and output costs | One execution tool, on-demand API discovery, explicit bounded snapshots, condition waits |
| [Playwriter](https://github.com/remorses/playwriter) | Stateful code execution, batching and browser handles | Persistent per-conversation `state`, async code, normal control flow, parallel independent tabs |
| [agent-browser](https://github.com/vercel-labs/agent-browser) | Compact element references and an observe/act/check loop | Document-scoped AX references, CSS selectors and native coordinate input |
| [Chrome DevTools MCP principles](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/design-principles.md) | Small composable operations, progressive complexity, concise diagnostics and actionable errors | Thin helpers plus page CDP; incremental event windows; explicit output budgets |
| [Cloudflare Code Mode](https://blog.cloudflare.com/code-mode/) | Code composes many tool operations without many model round trips | Agent code runs off the host thread and communicates through a JSON-only capability broker |

These sources inform the design; no external project's implementation is copied.
Codex's public documentation describes behavior, not a reusable internal browser
runtime. T3's current tools and broker were inspected directly; its
[evaluate timeout report](https://github.com/pingdotgg/t3code/issues/13513) also
motivates a specific recovery regression.

## Design iterations and decisions

1. **One tool per gesture:** easy to discover, but schemas, repeated observations
   and model round trips dominate common workflows. Keep gestures as code methods.
2. **Raw page evaluation only:** excellent for extraction, but cannot provide
   genuine input, past console messages, network response bodies or page capture.
   Add a host-side page capability and native input.
3. **Unrestricted Playwright/Node object:** familiar and flexible, but crosses
   browser/context/process/filesystem boundaries. It also requires a different
   connection model for native Electron pages. Use a common page-scoped CDP
   adapter with deliberate navigation/capture helpers instead. This API does not
   claim Playwright compatibility.
4. **Stateless code:** simple recovery, but repeatedly reconstructs tab handles
   and helpers. Retain explicit `state` in a per-session worker, expire idle
   workers, and return `sandboxId` so resets are visible.
5. **Final architecture:** two MCP tools, a task-owned execution engine, a
   validated broker, and desktop/runtime page adapters. Batch freely in code;
   order operations on each tab; allow concurrency across tabs. Keep outputs
   explicit and leave browser lifetime independent of execution-worker lifetime.

## Agent API

`browser_run` without `code` returns the versioned API guide, exact supported CDP
methods and connected host choices without launching Chromium. With `code`, it
executes an async JavaScript function body. `browser_reset` cancels the caller's
script and discards code state, preserving tabs and the task profile.

```js
state.tab ??= await browser.tabs.new('http://localhost:3000');
await state.tab.fill('input[name=query]', 'browser');
await state.tab.click('button[type=submit]');
await state.tab.waitFor(() => !!document.querySelector('[data-results]'));
console.log(await state.tab.snapshot({ interactive: true }));
await state.tab.screenshot();
return await state.tab.evaluate(() =>
  [...document.querySelectorAll('[data-result]')].slice(0, 10).map(e => e.textContent)
);
```

The globals are `browser`, `state` and `console`. Store reusable functions,
values and tab handles on `state`. Lexical declarations belong to the current
call. Page functions are serialized; pass dependencies as a JSON argument.
Await operations; no mutation is automatically retried. The guide in
`packages/browser-agent/src/guide.ts` is the authoritative detailed API reference.

Responses contain `sandboxId`, a JSON value, console output, image metadata and
an optional error. Images use MCP image blocks, never base64 duplicated into the
JSON result. Ordinary code errors preserve state and completed effects. Fatal
errors, deadlines and cancellation reset state and preserve live tabs.
`outcomeUnknown` means accepted work may already have happened; inspect before
repeating anything. An ordinary script error also does not undo earlier effects.

## Ownership and security

`packages/shared` owns private serializable code transport contracts.
`packages/browser-agent` owns worker execution, the public code facade, method
policy, bounded observations and ordered RPC. It has no Electron or Playwright
dependency. Backend and desktop adapters own real pages, network permissions,
debugger attachments, browser profiles and cleanup. MCP adapters only resolve
authenticated task/session identity and translate results.

Code executes inside a resource-limited worker and a VM context. No host
functions, objects, promises or exception instances enter that context: both
directions carry JSON. Dynamic code generation and imports are unavailable.
The broker validates every request independently. Node's VM is not treated as
an OS security sandbox: task ownership, CDP method restrictions, browser network
policy and Chromium's sandbox remain independently enforced. The worker is a
fault/resource boundary, not an arbitrary untrusted Node execution service.

The exact CDP allowlist excludes browser-wide targets, transport discovery,
filesystem operations, file inputs, raw navigation and raw screenshot methods.
The navigation helper applies task network policy. Capture applies pixel and
payload limits. Page `evaluate` is intentionally powerful within an owned tab;
it can read or change its DOM and make requests through that browser's task
network. Site content is untrusted data, not agent instructions.

Agents can list tab identities and ownership, but cannot read another session's
or a human-controlled tab. Handles capture the ownership epoch and reject a
takeover even if the tab is later handed back to the same session. After explicit
human handoff, explicitly acquire a fresh handle; reset if old code state should
be discarded. User-created tabs require user
closure. New API access is not exposed through `window.elevenex`; the renderer's
existing narrow bridge, CSP and guest security are retained.

## Lifecycle, transport and budgets

Each task owns its engine. Each authenticated conversation has at most one
active script and its own warm worker. Task destruction disposes workers,
observations and subscriptions. A five-minute idle deadline retires unused
workers. At most eight workers per task and twelve tabs are retained; live
browser tabs are not evicted to satisfy worker capacity.

Desktop code uses capability-negotiated, cancellable long polling with concurrent
execution and heartbeats. A delivered script is never delivered again. Running
IDs let cancellation/reset stop a desktop script. A lease replacement rejects
pending requests. Older desktops/backends retain the existing mailbox contract.
Remote-host code runs in-process through the same engine and page facade,
without adding a public CDP listener or a renderer network capability.

Desktop agent tabs use main-owned sandboxed offscreen views and the existing
stream presentation, so they can start with a hidden panel. Existing user tabs
retain native embedding. Agent views can be displayed and detached using the
existing stream frame; they do not switch to embedded guest presentation.
Runtime tabs keep their task-owned persistent Chromium context.

| Resource | Bound |
| --- | --- |
| Code / total deadline | 65,536 characters / 250–60,000 ms, default 15,000 |
| Synchronous JS slice / worker old heap | 250 ms / 64 MiB |
| Browser operations | 512 per call, 16 outstanding, ordered per tab |
| JSON return / console | 1 MiB / 32k characters and 100 messages |
| Screenshots | Four per call, 2 MiB each, at most 1920×1440 output |
| Screenshot source crop | 4096 pixels per axis and eight megapixels |
| AX output | 256–64,000 characters, default 16,000 |
| Event retention / page | 256 entries and 256 KiB; large entries summarized |
| Event read | 100 entries maximum with cursor and dropped-history indication |
| CDP parameters / reply | 128 KiB / 1 MiB |
| Network response buffers | 4 MiB total, 1 MiB per response |

Page evaluation has a ten-second sub-deadline. Timeouts terminate page execution,
stop loading and release input without destroying the browser connection. Already
accepted native operations cannot be undone. Browser popups, site permissions,
WebAuthn and human file workflows continue to follow the host's existing policy.
The short CSS targeting helpers address the main document. Page evaluation can
work with same-origin frames, and AX refs/CDP can address supported shadow DOM.
Cross-process iframe target attachment is not exposed; a future frame capability
needs the same explicit ownership and cleanup boundary. AX refs invalidate on document
replacement and can also become detached after DOM changes. They are not a
durable selector system. For robust application readiness, use explicit
conditions; a successful navigation alone does not establish readiness.

## Validation and extension

The backend's Jest suite covers worker isolation, state, cancellation, CPU and
microtask loops, payload limits, protocol denial, MCP SDK image results and
authenticated task scope. A real Chromium fixture covers native input, AX refs,
images, early diagnostics, timeout recovery and takeover. The Electron native
fixture exercises the same behavior on a hidden app-owned view. Native integration
tests use disposable profiles and HTTP fixtures; artifacts go under `artifacts/`.

Extend the public code API, guide and behavioral tests together. Add CDP methods
only after reviewing their resource, filesystem, network and ownership effects.
Long-lived routing/event subscriptions and file or trace artifacts require their
own bounded lifetime and cleanup contract; they are not implicit consequences
of exposing page CDP. A future CLI can call the same engine rather than create
a second browser owner.
