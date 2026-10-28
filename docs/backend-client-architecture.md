# Desktop backend client

The new desktop supports the backend incrementally as frontend features are
implemented. Build complete vertical slices for those features rather than
mirroring every legacy endpoint in advance. The product model is **project →
task → sessions**; a task owns its branch/workspace and conversations belong to
that task. Repositories remain resources within projects, not a replacement for
the task model.

This design applies to `apps/renderer` and `apps/desktop`. The existing
`apps/frontend` retains its HTTP/WebSocket clients and the backend retains their
supported contracts.

## Boundaries

```text
Angular feature store/controller         selection, loading, domain state
        ↓
Renderer named client methods            typed calls and stale reply guards
        ↓ window.elevenex
Typed preload / trusted window IPC       serializable requests/results/events
        ↓
Main domain adapters                     validation, DTO mapping, permissions
        ↓
Main transport / selected backend        bounded HTTP and owned event streams
        ↓
Existing Nest backend                    git, files, agents, durable task state
```

| Location | Ownership |
| --- | --- |
| `packages/shared/src/backend-client.ts` | Public serializable client results, errors and backend scopes |
| `packages/shared/src/index.ts` | Invoke/event contracts and named `ElevenexBridge` methods |
| `apps/desktop/src/backend-client/application.ts` | Local/remote target resolution and lifecycle subscriptions |
| `apps/desktop/src/backend-client/client.ts` | Per-window leases, in-flight work and invalidation |
| `apps/desktop/src/backend-client/transport.ts` | First HTTP adapter, limits and response validation |
| `apps/desktop/src/backend-client/ipc.ts` | Trusted sender, runtime argument validation and handler cleanup |
| `apps/renderer/src/app/backend/backend-client.service.ts` | Per-window Angular client state and bridge injection |
| `apps/renderer/src/app/workspace` | Project/task selection, bounded navigation windows, setup and settings |
| `apps/renderer/src/app/workspace/workspace-resume.ts` | Saved window/backend context and bounded save coordination |
| `apps/renderer/src/app/workspace/workspace-restoration.ts` | Read-only saved-resource reconciliation, keyset ordering and immutable restoration windows |
| `apps/desktop/src/backend-client/workspace.ts` | Named workspace adapters, runtime validation and DTO mapping |

Keep the preload and IPC handlers thin. As support grows, separate projects,
tasks, sessions, repository browsing and agent streams by responsibility. Share
transport mechanics where there is real duplication; avoid a single client or
store containing every domain. The current info-only adapter is a small starting
point, not a requirement to put all subsequent operations into these files.

Main resolves the endpoint from `BackendManager` and `RemoteManager` for the
verified sending window. A remote request uses `RemoteManager.backendAccess`,
including its transient private capability. URLs, methods, headers, filesystem
paths and credentials cannot be chosen through the client bridge. Keep the
production CSP unchanged. Do not copy the legacy renderer's direct networking
into this renderer, import backend implementation types into Angular, or expose
a generic `request`, `fetch`, IPC dispatch or socket API.

Shared contains public contracts, not Nest, Drizzle, Electron, Angular or runtime
validation code. Main validates untrusted arguments and server responses at
runtime and maps wire DTOs explicitly into those contracts. Accept additive
server fields without forwarding them by accident. Keep legacy naming and
transport quirks in the adapter; expose the intended task/session model to views.

## Implemented slice

`backendInfo(scopeId)` calls the existing `GET /api/info` for the selected
environment. It validates the response and its exact expected release SHA,
returns only `backendSha`, and uses the same local/remote selection as future
domain operations. It accepts only a main-issued scope ID.

Each window has a `BackendClientState` with an increasing `revision` and either
a ready `scope` or null. Scope IDs are opaque, bound to the window and never
persisted. Main rotates them when the selected endpoint changes, the local
backend leaves ready, the remote generation/instance changes, or the document
reloads. Equal resource IDs in two environments therefore cannot collide.

Main cancels pending reads when their scope is invalidated, the window closes,
the renderer process exits, or the app quits. Concurrent info reads share a
single request within one window/scope. There is no persistent response cache,
background polling, automatic retry, command replay or offline mutation queue.
Info requests have a five-second deadline and a 16 KiB response limit, including
chunked bodies; redirects are rejected before a capability can reach another
endpoint. These limits belong to this small operation, not every future payload.

Expected failures cross IPC as `BackendResult<T>` rather than relying on
Electron to serialize custom errors. Codes distinguish unavailable/stale scope,
timeout, transport, HTTP status and incompatible response. Messages are fixed
adapter text; raw response bodies, credentials and diagnostic URLs stay private.
Domain adapters may map allowlisted conflict codes from a bounded 4 KiB JSON
error body to fixed text. Project deletion maps cleanup failures and concurrent
task creation to explicit retry instructions. Unknown codes and malformed
or oversized error bodies retain the generic HTTP error.
Malformed IPC inputs and untrusted senders are rejected before the domain client.

The Angular service subscribes before requesting the initial snapshot and uses
`revision` to reject an older bootstrap reply. It also rejects an info reply if
the scope changed while awaiting IPC. Use it through Angular injection:

```ts
private readonly backend = inject(BackendClientService);
// In the owning feature's async load operation:
const result = await this.backend.info();
if (result.ok) {
  // Consume result.value.backendSha after checking this feature's own selection.
} else {
  // Map result.error.code into this feature's unavailable/retry state.
}
```

The service is lazy: future shell/feature composition must inject it to start
its subscription. It owns client connection state only. Download/setup progress,
SSH challenges and recovery controls remain on the existing lifecycle bridge;
the client does not introduce a second connection/retry coordinator.

## Connected workspace

The workspace probes `workspaceRevision(scope)` before its first resource load.
The reply advertises protocol version 1 and a monotonic navigation revision.
An unsupported/older engine produces an explicit update message. Projects,
tasks and sessions use bounded keyset pages; repositories, branch search and
one-directory folder suggestions have separate bounds. Project appearance and
task stages live in an additive desktop metadata table, independent of the
legacy task preparation lifecycle. Existing endpoints remain compatible.

The workspace owns navigation state and preparation polling. Conversation and
git state have separate owners for the selected resource. Background updates
use bounded reads and revision reconciliation, with visibility, stale-selection
and cleanup guards. Git commits support explicit messages or generating one from a frozen selection; push never forces, and sync
only fast-forwards. Close reads authoritative session/process counts and calls
the existing task lifecycle. Interrupted mutations return `outcome-unknown` and
are reconciled before another attempt; prompts are never automatically replayed.

Sidebar session activity uses the backend's existing in-memory hook snapshots
and a bounded scalar provider-event cache. It does not hydrate runtimes, request
model catalogs or read history for unselected sessions. Only semantic activity
changes invalidate navigation; streamed text and tool progress do not reload
the sidebar. Session pages supply authoritative activity for the visible window.

The side views currently contain shells only. The implementation does not
introduce direct renderer networking, generic IPC, a second backend or a
replacement persistence framework. Selected sessions retain their task header
with an empty main region. See the [workspace guide](../apps/renderer/src/app/workspace/README.md)
for the supported actions, limits and ownership.

Failed-task DTOs may include optional bounded `setupIssue` display data.
`workspaceRetryTask(scope, taskId, recovery?)` retains existing two-argument
calls and supports named `use-existing`, `snapshot` and `exceed-worktree-limit` choices. Main
validates arity, scope and reply/task identity. Backend recovery reads the saved
failed task and delegates to the existing consent/checkout rules; raw errors,
configuration, caller-chosen paths and arbitrary setup patches stay outside this
operation. Uncertain setup writes require durable reconciliation.
Quota failures expose a safe count/limit explanation and optional
`canExceedWorktreeLimit` flag while retaining the existing `other` issue code for
older desktop clients. Explicit quota recovery delegates to `confirmOverLimit`
on the saved task; it does not change the configured repository limit.

## Adding a frontend feature

1. Read the backend controller, DTOs, service behavior, relevant legacy consumer
   and tests. Establish the intended resource ownership and performance budget.
   Use IDs, explicit bounds and cursors; avoid whole-repository payloads.
2. Design the smallest named domain operation and public DTO needed by the UI.
   Define arguments/results/events in shared and extend `ElevenexBridge` and
   preload together. Reads and mutations must carry an expected backend scope.
   Extend the scoped client at a cohesive boundary instead of duplicating target
   resolution or creating parallel scope registries.
3. Add runtime input validation and operation-specific authorization in main.
   Derive window ownership from the trusted sender. Check the scope before
   dispatch and after completion. Validate resource IDs, query/page sizes and
   response shapes; enforce path confinement for any actual path operation.
4. Add a main adapter for the existing HTTP route or event protocol. Give each
   operation explicit time/output limits, cancellation and cleanup. Coalesce
   duplicate reads by **scope + operation + normalized arguments**; do not share
   mutations or pending work across windows implicitly. Only extract common
   transport code as the second real operation needs it.
5. Add named renderer methods and a feature-owned store/controller. Keep
   platform calls out of templates and presentational components. Use Signals
   and `computed` for derived state. Give async feature loads their own selection
   revision/abort ownership so changing task/session rejects a late reply even
   when the backend scope remains the same. Resource operations must accept the
   scope that supplied their IDs: capture it with the selected task/session and
   pass it through the renderer client to IPC. Do not substitute the latest scope
   at dispatch, since the same numeric resource ID can identify unrelated work
   in another backend. Check it before dispatch as well as after completion;
   stale mutations must never be sent to the newly selected environment.
   The renderer's argument-free `info()` method can capture the current scope
   itself. The initial info operation only cancels at scope/window lifetime;
   add per-request cancel IDs when a feature
   needs finer-grained cancellation, without exposing `AbortSignal` over IPC.
6. Add focused public-behavior tests: invalid inputs/replies, stale scopes and
   selections, failure recovery, bounded results, window isolation, teardown,
   type contracts and existing-client compatibility. Use the normal desktop
   checks and native smoke; use the capture workflow when UI is added.

Cache domain data only with a defined owner and eviction policy. Keys include
scope plus resource identity, query and cursor. Keep entity data separate from
bounded ordered page IDs. Release task/session observers on navigation; clear or
replace caches on environment changes. Scope readiness alone does not mean a
previously selected task/session still exists: reconcile its IDs first.

## Large repositories and live data

Directory children, file search, branch search, commit history and transcripts
need bounded queries with stable ordering. Prefer backend cursor/keyset
pagination to fetching everything and filtering in Angular. Use incremental
transcript windows and cursors rather than sending an entire conversation again.
Watch only visible/selected resources and relevant ancestors. Unrelated commits
must not rescan the file tree or reload every branch/history page.

Future live adapters stay in main, speaking the backend's actual protocol
(currently raw WebSocket for several domains and Socket.IO for others). A native
WebSocket client cannot impersonate Socket.IO. Add a protocol dependency only
under the repository's dependency policy when a concrete feature needs it.
Expose typed domain watch/unwatch operations and bounded event batches over IPC,
with window/scope/resource ownership and no Electron event objects.

Subscribe before reading a snapshot. Where backend events have no replay cursor,
buffer bounded invalidations during that read and reconcile the affected visible
pages afterward; do not pretend there is a lossless log. As event requirements
grow, add monotonic sequence/cursor and bounded replay support to the backend.
Coalesce noisy file/commit invalidations, cap buffers and define backpressure.
If a buffer overflows or a cursor expires, explicitly reconcile the affected
resource window rather than silently dropping changes or loading all history.
Distinguish replaceable status from ordered agent/token/terminal output.

On reconnect, generation/instance changes invalidate old work. Reconcile selected
resources and consumed cursors before restoring watches. Never recreate a task,
replay a command or resubmit an agent prompt because a connection recovered.
There is no event streaming or replay implementation in this initial slice.

## Mutations and backend evolution

Confirmed desktop project deletion finishes open tasks through the existing task
lifecycle, with stop approval, in bounded pages and sequential cleanup. It also
strictly stops legacy/default-workspace and already archived sessions before
deleting project metadata. Dirty and external checkouts remain on disk. Cleanup
failures keep project history for retry; concurrent task creation is checked
again in the final delete transaction. Duplicate in-flight deletion requests for
one project share the same backend operation. The desktop gives cleanup a
three-minute deadline and retains unknown-outcome reconciliation on interruption.
Existing legacy and MCP project-delete contracts keep their defaults and guards.

Reads may gain bounded retry only for classified transient errors while their
scope is still current. Mutations need an explicit domain policy. If transport
fails after dispatch, the outcome can be **unknown**: query durable state before
offering a retry. Use request IDs and backend deduplication for retryable creates
(task creation already has a `requestId`); do not infer that other operations are
idempotent. A stale-scope result rejects applying the reply, but cannot undo a
mutation already accepted by the old backend. Cancellation has the same limit.
When adding mutations, define an operation-specific outcome for uncertain
completion so feature UI can offer reconciliation. The initial read error codes
alone do not establish whether a dispatched write was accepted.

**Agents are authorized to change the backend as part of implementing frontend
features.** Improve or optimize existing behavior, add endpoints/events/features,
and adjust internal architecture when that improves performance, correctness,
or alignment with the intended product. The backend is not a frozen constraint.
Prefer fixing a backend limitation to adding repeated client workarounds.

Preserve backward compatibility for the active legacy app, desktop releases,
remote runtimes and other supported API/MCP consumers. Prefer additive optional
fields, new bounded endpoints, explicit capabilities and staged migrations;
retain existing defaults, response shapes and semantics for existing callers.
New desktop adapters may map old DTOs without renaming or removing their wire
fields. When introducing capabilities, check them explicitly rather than assuming
that a matching `/api/info` SHA implies a future optional protocol exists.
An additive bounded endpoint can coexist with an existing unbounded legacy one.

**If a breaking change would be useful, ask the developer whether it is allowed
before implementing it**, unless that exact break was already authorized. State
the concrete benefit, affected callers, migration/versioning plan and alternative
that preserves compatibility. Do independent compatible work while awaiting the
decision. Database changes follow the existing Drizzle migration workflow;
client integration does not authorize data loss or destructive migrations.

## Validation and current limits

Run `pnpm desktop:lint`, `pnpm desktop:test`, and `pnpm desktop:build` from the
root. Tests include real loopback HTTP, malformed/oversized responses, deadlines,
coalescing, lifecycle invalidation, remote capability routing, trusted IPC and
Angular subscription cleanup/races. Negative contract assertions also run through
`tsc`. Use `apps/desktop/test/electron-smoke.cjs` with the installed Electron for
real sandboxed preload/protocol verification; it uses disposable fixture assets
and a backend, and does not certify a packaged app or a published remote runtime.

The product renderer uses the supplied design system and the connected workspace
slice above. There is no full backend API catalog, event replay client, offline
mutation queue or packaged-app verification in this slice. See the
[desktop README](../apps/desktop/README.md),
[remote ownership/recovery guide](../apps/desktop/REMOTE_DEVELOPMENT.md) and
[capture guide](../scripts/desktop-capture/README.md) when extending it.

The commit-panel slice adds an optional `commitPanel: true` capability to the
workspace revision probe, a named `workspaceCommitPreview` bridge operation and
optional selection/revision/push fields on the existing commit action. Existing
explicit-message calls retain their defaults. Preview uses a read-only POST for
bounded exception lists, coalesces identical requests, and returns at most 100
file rows, 20 running-session names and scalar totals. Filtering searches every
changed file on the backend. A task-owned 4 MiB metadata cache reuses unchanged
snapshots across filters/pages; its lifetime ends with the backend service.

Commit exceptions are bounded to 1,000 paths / 64 KiB per list, and match only
server-observed changed paths. Likely secret paths require explicit inclusion.
The commit revision includes HEAD, changed paths and index bytes. Existing files may continue changing before submission; their contents are frozen when Commit is pressed. Preview caches also key on the worktree fingerprint. The backend
captures a private index before generating a message, checks concurrent branch
and index changes before publication, and holds the real index lock only through
commit/publication. Excluded staged entries remain staged; later working edits
remain uncommitted. Temporary files and owned locks are released on success and
failure. Failures after a saved commit retain an unknown outcome for reconciliation.
The existing git status operation may carry an optional commit phase; the feature
polls it only during its pending commit, with selection/epoch/cleanup guards.


The optional `sessionArchiveHistory: true` revision capability adds independent
archived-history browsing through `workspaceSessions` with `state: 'archived'`.
`state: 'normal'` explicitly requests nonarchived sessions; omitting state retains
existing active-task and closed-task semantics. Ordering, bounds and keyset
cursors apply separately to each lifecycle window. Main validates the state and
reply lifecycle/task identity. The renderer loads archived windows lazily, keeps
them separate from normal-session activity and pagination, and reuses the named
restore operation without requiring an Undo notification. No additional channel,
generic transport, migration or unbounded history response is introduced.
