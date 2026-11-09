# Playwright in the Elevenex browser

Agents write Playwright JavaScript against task-owned pages. Playwright itself
implements selectors, locator chaining, actionability, frames, network routing
and waits. Elevenex owns authorization, execution lifetime, protocol transport,
artifacts and human interaction. It does not implement another selector engine.

## Boundaries

1. The existing code worker receives JSON descriptions of opaque Playwright
   handles. Its facade preserves synchronous locator construction and metadata,
   async actions, regular expressions, binary payloads and callback closures.
   Actual Playwright objects and privileged Node functions never enter the code
   realm. A private string-only utility callable supplies URL/binary conversion
   and bounded numeric timers; it returns no host objects.
2. A separate resource-limited worker hosts the typed broker and delegates public operations to the pinned Playwright library.
   It validates member names and file arguments, associates every derived handle
   and callback with its page authority, bounds output and disposes resources.
   Agent functions used by evaluate run only in the page. Agent event/route
   callbacks run only in the code worker, never through host eval/Function.
3. Each conversation has a private Playwright connection using the public
   `connectOverCDP(transport)` API. There is no debug listener or browser endpoint.
   A scoped transport presents a virtual browser containing only authorized
   task pages and their attached frame/worker targets. Root commands cannot
   discover other profiles, create arbitrary contexts or shut down Electron.
4. Main retains all live leases, checks profile authority before and after cookie
   operations, and aborts paused requests before detachment. A stuck Playwright
   regex cannot stop timeout or takeover cleanup. Worker environments and inherited
   command-line hooks are cleared; main owns temporary-root removal on worker exit.
5. Native Electron and runtime Chromium provide page protocol sessions with
   explicit cleanup. Child sessions are confined to the parent page. Human
   takeover detaches the agent's view of that page and stops queued Playwright
   retries; the real tab remains alive. Opener-linked popups form one control
   group because same-origin JavaScript can follow window references independently
   of CDP. Taking over any member synchronously revokes every member. Explicit
   handoff covers the group; unrelated pages remain independent. Explicit
   browser.page acquisition can claim available task tabs. Stop agent and human
   input pause the group until Hand back; reset/reconnect cannot clear the pause.
   Internal transport reads never acquire control. Cancellation closes the private agent
   connection, releases input and routing, and never replays code.

This is a serialization membrane around real Playwright, not a security claim
about Node's VM. The host validates opaque handles, operation membership,
protocol authority and resource paths independently. Takeover revokes new agent
commands; it cannot undo earlier DOM changes, injected scripts or activity
performed by the website. It is not a guarantee that a page is untampered or
that credentials can be redacted from arbitrary page code. Protocol sources, clients,
timers, observers and callbacks have explicit owners and cleanup.

## API and compatibility

The code environment provides `context`, `browser`, `state`, `console`,
`emitImage`, `human` and Playwright assertions. Standard code includes:

```js
const page = await context.newPage();
await page.route('**/api/items', route => route.fulfill({
  json: [{ id: 1, label: 'Mock item' }]
}));
await page.goto('http://localhost:3000');
await page.getByRole('button', { name: 'Open' }).click();
await expect(page.getByText('Mock item')).toBeVisible();
await emitImage(await page.screenshot({ fullPage: true }));
```

Existing `browser.tabs` helpers remain available for code written for the first
API. Metadata and guide discovery never launch a browser. Ordinary operations
use the task's existing profile; task-wide context changes require authority
over populated pages. Unsupported operations fail explicitly rather than return
fabricated success. A new context must be allocated by Elevenex; agents cannot
choose an external browser, proxy or profile directory.

File paths are confined to an execution-owned artifact directory, never resolved
against the backend/Electron working directory. Uploads accept Playwright file
payloads; arbitrary host paths are excluded. Route fulfillment accepts data and
confined artifacts. HTTP helpers must use the task network policy, including
redirects and DNS rebinding protection. No unrestricted host fetch is exposed.

Synchronous URL predicates in waitForURL/toHaveURL/frame matching cannot cross an
async code boundary; use string/RegExp patterns or an async event predicate.
HTTP route predicates are adapted with async matching, matching-only counts and
fallback to the next Playwright handler. Offline WebSocket mocks must be installed
before navigation/reload; forwarding to a server and HAR imports are currently
excluded. Context creation, permission grants, TLS bypass and host filesystem or
browser endpoints are also excluded. These operations fail explicitly. The
[agent guide](../packages/browser-agent/src/guide.ts) is the detailed surface and
budget reference.

## Human requests

`human.requestAction(page, { message })` and
`human.requestElement(page, { message })` create task-owned tickets and return
immediately. They transfer the requested tab to the human. The script does not
remain blocked on a short execution deadline. The agent can finish its turn and
later inspect `human.result(id)` or cancel with `human.cancel(id)`.
`browser_wait_user` waits for completion/cancellation/expiry without a running
script. Its timeout leaves the request pending. After confirmation, use
`await browser.page(ticket.tabId)` or `await human.locator(ticket.id)`; stale
pre-handoff handles stay revoked.

The browser shows the requesting conversation's task-scoped request, with explicit
complete/cancel controls. An element request starts a frame/shadow-aware picker in an
explicit selection mode. A successful selection records an ephemeral DOM marker/frame path,
document/loader identity and geometry without field values. Completion returns
control to the requesting conversation, not whichever session happens to be
selected in the sidebar. Navigation/replacement invalidates stale selections.
Human requests survive code resets; task shutdown, expiry and page closure cancel
them. Browser requests never silently send an agent prompt or resume old code.

## Failure cases and verification

Cover real locators and retrying actions; Promise.all(wait, action); route callback
closures, fulfillment and errors; iframe navigation and target detachment; hidden
native pages; screenshots and binary handles; denied root/context/file access;
cross-session handles and callbacks; canceled callbacks and paused requests;
timeouts during startup and page evaluation; human takeover during retries;
human completion after worker expiry; stale element selection; navigation,
scope/window/task closure; limits; artifact cleanup and compatibility with the
legacy mailbox. Real Chromium, native Electron, MCP SDK and renderer captures
provide separate evidence. Passing a facade unit test does not establish native
or protocol isolation.

## Visual element references

Confirmed human element selections include a historical, bounded crop with 48 CSS px of context. `browser_wait_user` and `human.result` return actual MCP image content separately from metadata; JSON/code results omit base64. Reading that snapshot survives navigation, while `human.locator` still validates live document and element identity. The viewer can stage the same reference in chat without confirming a handoff or sending a prompt. See [the snapshot and mention contract](browser-element-mentions.md).
