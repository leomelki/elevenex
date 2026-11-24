# Desktop backend client

Conversation reads optionally select `loadingMode: 'window' | 'progressive'`
through the existing scope-bound `sessionChatRead`. Window mode caps records at
320 / 2 MiB; progressive mode and omitted options retain 80 / 512 KiB. Adjacent
pages use 80 / 512 KiB in either mode to preserve overlap in the rolling window.
Main validates the mode and reply count and retains its 4 MiB transport limit.
The renderer requests progressive pages from the first read. With the
window-mode override, an uncached opening still pending after 1.75 seconds
switches to progressive pages for the application connection. The root
`SessionChatLoadingPolicy` owns that transient choice separately from connection
state and per-chat drafts. Scope rotation and application restart reset it.
The renderer cancels superseded reads and discards stale replies. The backend
shares in-flight hydration with the replacement.
The progressive profile opts into completed-turn summaries with
`summarizeCompleted` and also requests summaries for small recent turns with
`summarizeRecent`. A summary occupies one paging entry at the prompt and
advances past the saved turn's last source item in the forward direction.
Its versioned `sessionChatTurnWork` read keeps hidden activity out of initial
history, including when a single turn spans hundreds of tool records. Main
requests `complete=1` on the first compact timeline read and validates the
turn, revision, offset and reply bounds under the same cancellable window
lease. A complete response is bounded to 4 MiB and 32,768 source slots. The
backend returns HTTP 413 if either limit would require continuation. Older
engines can return ordinary work pages or compact batches. The renderer
collects those replies before showing the timeline. Older clients retain the
existing page formats and limits.
Completed turns reconcile repeated row identities before computing the visible
reply, counts and activity offsets. Both history formats use the same saved
change reconciliation as Review and can carry full line totals with their
three-file preview.

Both history modes and turn activity reads can opt into `deferToolDetails`.
Tool records then carry headings and versioned evidence addresses while their
input and output strings stay empty. `sessionChatToolDetails` fetches one tool
record and an optional related receipt under the same scoped, cancellable
lease. Main checks the exact task, session, item IDs, evidence revisions,
pairing and payload sizes. The backend rechecks session ownership and serves
matching evidence from a bounded per-feed cache or from the provider history
and live overlay. Optional call and receipt references keep the same evidence
pair accessible when a history window or activity page splits the operation.
The engine resolves missing peers in one pass over the available source and
caches up to 1,024 saved offsets per feed without retaining their payloads.
The evidence cache favors the requested paging edge, including the
newest rows on the initial open. It retains up to 256 records and 1 MiB of
UTF-8 string data per feed. History revision changes invalidate the engine cache.
The original-content reader still pages the full transcript when requested.
See the
[session adapter](../apps/renderer/src/app/session-chat/README.md) for policy and
cache ownership. The backend feed reuses emitted cursor offsets and prompt spans
within a history revision, and skips transcript projection on idle heartbeats.
The provider still supplies the complete source snapshot for history reads.

### Selected chat stream

Engines advertising `chatStream: true` in `workspaceRevision` serve
`GET /api/desktop-workspace/tasks/:taskId/sessions/:sessionId/chat/events`.
Main opens the stream against the selected backend with its private credentials.
The request carries a bounded loading profile and the last applied cursor in
`Last-Event-ID`. The first event supplies the current state and either a
snapshot or the changes since that cursor. Subsequent events carry ordered
record replacements, text appends and changed state. SSE comments keep the
connection alive without reading the runtime or waking Angular. The existing
JSON read still serves adjacent history pages, archived chat and older desktop
clients. Older engines keep their current long-poll behavior.

Runtime and persisted session events wake the selected feeds. Provider
listeners are shared across feeds, and updates arriving during hydration or a
slow write are reconciled on the next projection. The backend retains bounded
fingerprint checkpoints for each feed and view. A new provider, saved-history
revision, expired cursor or gap in the live window returns a bounded authoritative
snapshot with history cursors. Transcript payloads are limited to 4 MiB per
frame, and backpressure prevents a slow network socket from growing a queue of
pending projections.

Snapshot and adjacent-page reads sample the runtime after reading history.
They reconcile the two sources in a single order before selecting page edges.
Shared IDs retain their live order, and saved entries supply the context before
and between them. When the runtime retires a turn before every observed row has
been saved, the feed carries its bounded tail through the handoff. A history
rewrite clears that tail. Both transports verify that the window supports an
append or update before emitting one, and snapshot when the ordering changes.

The named watch, acknowledge and unwatch bridge operations allow one live chat
per window. Main validates the cursor chain, the scoped resource and each
frame before forwarding it. A single outstanding delivery bounds Electron
IPC. Main waits for the renderer to apply the page before advancing the resume
cursor. On EOF or a stalled connection it reconnects with jittered backoff and
the applied cursor. Scope rotation, session navigation, visibility changes and
destruction release the watch. After backend identity changes, workspace
restoration verifies the selection before opening a new watch. Reconnects and
refreshes issue only reads.

### Editing a sent message

Engines mark editable saved user records with `editable: true`. Main reads
the bounded edit snapshot through `sessionChatPromptEdit`, checking the scope,
task, session and item identities.
The `edit-prompt` command sends revised text with the snapshot revision. The
engine validates that revision and preserves the original attachments and
context before asking the selected harness to rewind and submit. A changed
history boundary returns a conflict. History replacements publish
`historyRewrite` so readers on older pages can return to the live tail.
An interrupted write requires a fresh read before another send.

Terminal service URLs use the named `taskTerminalOpenPort` and
`taskTerminalCopyPort` bridge operations. Both accept only a scoped
task/terminal/port, freshly verify the owned listener and use the window's
managed remote forward. Copy writes the validated URL through Electron's native
clipboard API and returns that URL without opening a browser. Browser clipboard
permissions remain denied; there is no general renderer clipboard API. The
display initially uses observed service metadata and updates to the resolved
local URL after either action. No listener is started just to render the row,
and neither action accepts an arbitrary URL from the renderer.

Session chat optionally advertises `sessionMentions: true`. Its existing send
action accepts up to eight distinct positive `sessionIds`. Main validates and
preserves only those IDs; the backend resolves them through the existing
conversation exporter before submitting, with bounded inline snapshots and no
renderer-supplied transcript/path. Snapshots remain in durable prompt history;
ordinary desktop message/queue projections hide the context blocks so pending
receipts still match the original text. No new transport, unrestricted read or
automatic retry is introduced; omitted IDs preserve existing callers.
User transcript items may also contain bounded `mentions` (session ID/title
only) derived from saved prompt headers. Main validates these optional fields;
older engines omit them. Snapshot contents and export paths remain outside this
metadata. Saved history and incremental item events use the same projection.

Engines advertising `presetEditing` accept saved preset update, reorder,
delete and restore actions through `sessionChatCommand`. The desktop
validates each action and the deletion receipt. The engine checks the same
catalog revision used by default changes inside the settings transaction.
An automatic application of an edited preset also carries the expected chat
mix and catalog revision. Older engines retain the original preset controls.

Add backend operations as each desktop feature needs them. The product model
is **project → task → sessions**. A task owns its branch and workspace, and
conversations belong to that task. Repositories are resources within projects.

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
production CSP restrictive. Main owns HTTP and WebSocket traffic. Angular uses
shared contracts and calls named domain operations through the bridge.

Shared contains public contracts, not Nest, Drizzle, Electron, Angular or runtime
validation code. Main validates untrusted arguments and server responses at
runtime and maps wire DTOs explicitly into those contracts. Accept additive
server fields without forwarding them by accident. Normalize wire field names
and transport details in the adapter before exposing the task/session model to
views.

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
task stages live in a desktop metadata table separate from task preparation
state.

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
the sidebar. Engines advertising `revisionWait` support a cancellable revision
wait through the existing per-window HTTP transport. It wakes on changes or after
25 seconds, uses a pre-read cursor to avoid missed updates, and never replays
mutations. Hidden windows cancel the wait; visibility resumes reconciliation.
Older engines keep five-second revision polling. Disconnects back off, and failed
reconciliation retains its cursor for retry. Session pages supply authoritative
activity for the visible window; live rows update before unrelated archive reads.

Activity normalization covers Claude (native and terminal), Codex, Pi and both
OpenCode versions. Explicit decisions take precedence over work, errors over a
stale interrupt flag, and independent background work remains running. Terminal
Claude hooks publish activity before metadata persistence and clear provisional
activity if persistence fails. Tool/elicitation results resume work; task and
subagent completion do not complete the main turn. `StopFailure` publishes an
optional failure flag while retaining the legacy three-value activity protocol.

Browser uses narrow task-owned local guest and remote streaming adapters; see the
[production browser guide](../apps/renderer/src/app/task-browser/README.md) for
its mailbox, forwarding, ownership, bounded resources and conservative privacy
policy. Terminal connects real user-owned task PTYs through the scoped bridge; its ownership is described below. The implementation does not
introduce direct renderer networking, generic IPC, a second backend or a
replacement persistence framework. Selected sessions compose the
[connected chat adapter](../apps/renderer/src/app/session-chat/README.md) with
bounded history, streamed work, decisions and draft recovery. See the
[workspace guide](../apps/renderer/src/app/workspace/README.md)
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

Session rows may include `canDelete`, an optional engine-owned eligibility flag.
The named `workspaceDeleteSession(scope, {taskId, sessionId})` permanently removes
only unstarted sessions in a ready active task. The backend rechecks lifecycle,
provider identities, completion and live activity without yielding before claiming
the row. The deletion lifecycle releases prewarmed runtimes and processes. Cleanup
failure restores the unused row for retry. Children return to task level. The
desktop falls back to its archive action when an older engine omits the flag.

## Adding a frontend feature

1. Review the backend controller, DTOs, service behavior, tests and affected
   supported consumers. Establish the resource ownership and performance budget.
   Use IDs, explicit bounds and cursors to keep payloads bounded.
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

Live adapters stay in main, speaking the backend's actual protocol
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

## Mutations and backend evolution

Confirmed desktop project deletion finishes open tasks through the existing task
lifecycle, with stop approval, in bounded pages and sequential cleanup. It also
strictly stops legacy/default-workspace and already archived sessions before
deleting project metadata. Dirty and external checkouts remain on disk. Cleanup
failures keep project history for retry; concurrent task creation is checked
again in the final delete transaction. Duplicate in-flight deletion requests for
one project share the same backend operation. The desktop gives cleanup a
three-minute deadline and retains unknown-outcome reconciliation on interruption.
The MCP project-delete contract uses its own defaults and guards.

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

The legacy frontend in `apps/frontend` and its Electron shell in
`apps/electron` are slated for removal. Agents are authorized to break or
remove backend contracts used exclusively by those apps as part of the
requested work.

Preserve backward compatibility for supported `apps/desktop` releases, remote
runtimes and API/MCP consumers. Prefer additive optional fields, bounded
endpoints, explicit capabilities and staged migrations. Preserve the defaults,
response shapes and semantics those consumers rely on. Check optional protocol
support through the relevant capability. The `/api/info` SHA identifies the
backend build.

**Ask the developer before breaking a supported contract**, unless that break
is already authorized. State the concrete benefit, affected callers, migration
plan and compatible alternative. Do independent compatible work while awaiting
the decision. Use the existing Drizzle workflow and preserve user data through
migrations.

## Validation and current limits

Session navigation derives inactive historical activity from persisted lifecycle,
completion markers and native conversation IDs. A previously used conversation
without a completion timestamp is Done, while an unused session is Queued.
Explicit live provider states still take priority. The shared provider inference
also repairs legacy default-harness mismatches in navigation replies. Quiet idle
snapshots are omitted from the bounded live cache so they cannot evict active
work; lifecycle changes and authoritative idle hooks release stale live entries.
These reads do not hydrate runtimes, read histories or backfill timestamps.
Codex and Pi persist successful completion markers after final transcript/change
evidence is available. Interrupted, failed and invalidated turns do not create
unseen replies, and marker-storage failures never replay agent work.

Chat state optionally supplies `unseenCompletionAt` (an ISO completion version).
Its presence advertises support for the additive `mark-seen` chat command.
Main validates both forms; the backend checks task/session membership and clears
only a still-unseen matching completion in one conditional database update.
Legacy `mark-reviewed` callers retain unconditional behavior. Repeated or stale
acknowledgments are harmless and do not emit navigation invalidations. A successful
change invalidates bounded sidebar windows and wakes selected chat feeds across
windows, without reloading transcript history. New completions also invalidate
the feed's history version so persisted final output is included.

Session chat optionally includes bounded `planUsage` on its existing state
reply. The backend projects subscription-only Codex/Claude OAuth snapshots;
main validates the provider identity, status, dates, up to eight unique windows
and finite remaining percentages before forwarding them. Older engines can omit
the field. Existing feed invalidations carry allowance changes without replaying
prompts or reloading transcript history. This is a display capability; it does
not implement scheduled sending or automatic pause/resume.

Run `pnpm desktop:lint`, `pnpm desktop:test`, and `pnpm desktop:build` from the
root. Tests include real loopback HTTP, malformed/oversized responses, deadlines,
coalescing, lifecycle invalidation, remote capability routing, trusted IPC and
Angular subscription cleanup/races. Negative contract assertions also run through
`tsc`. Use `apps/desktop/test/electron-smoke.cjs` with the installed Electron for
real sandboxed preload/protocol verification; it uses disposable fixture assets
and a backend, and does not certify a packaged app or a published remote runtime.

The product renderer uses the supplied design system and the connected workspace
slice above. See the
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

Desktop commits with a blank message use the same provider preference as session
startup: explicit configured defaults take priority, otherwise the last-used
provider is selected. Model selection remains with the text-generation service's
provider defaults. Manual messages require no provider. Direct Git API/MCP callers
continue to supply their own provider for generation. Provider failures are not
retried automatically or replaced with heuristic messages; malformed AI output
can be corrected within a limit of three generation attempts. Staged diff context
is read as a bounded prefix with a deadline, without external diff drivers or
text conversion.

Commit exceptions are bounded to 1,000 paths / 64 KiB per list, and match only
server-observed changed paths. Likely secret paths require explicit inclusion.
The commit revision includes HEAD, changed paths and staged blob IDs/modes.
Ordinary index stat/cache refreshes do not invalidate a reviewed selection.
Existing files may continue changing before submission; their contents are frozen
when Commit is pressed. Preview caches also key on the worktree fingerprint. The backend
captures a private index before generating a message, checks concurrent branch
and index changes before publication, and holds the real index lock only through
commit/publication. Excluded staged entries remain staged; later working edits
remain uncommitted. Temporary files and owned locks are released on success and
failure. Failures after a saved commit retain an unknown outcome for reconciliation.
The Git status reply may additionally supply an optional `changesRevision`: a
64-character opaque digest of the local HEAD/index/worktree versions already
collected by Git status. Remote tracking changes do not invalidate it. Main
validates it; older engines omit it. The selected renderer uses this token to
skip unchanged background commit previews and retains one bounded default page.
Recent pages are reused for five seconds, with expired reads coalesced and the
existing submission revision guard unchanged. A background working-edit update
invalidates the cache without cancelling an independently checked panel window.
Task/scope changes and mutations still reject old file reads. Switching sessions
inside the same task retains its pending Git operation and panel provider.
This token is a cache validator,
not a replacement for commit authorization or the frozen-index revision.
Known commit conflicts carry allowlisted codes for moved selections, unresolved
conflicts, index contention, message-generation failure, Git rejection and a saved
commit whose push failed. Main maps these to fixed recovery instructions; raw
provider/hook output stays private. Saved-commit reconciliation failures retain
the unknown-outcome policy. Snapshot Git operations preserve the augmented
workspace environment so hooks use the configured tools.
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

The chat media slice adds optional attachment references to transcript items and
`sessionChatMedia(scope, { taskId, sessionId, itemId, mediaId, requestId })`.
References, rather than filesystem paths, cross IPC. The backend rechecks session
membership and confines referenced raster files to the task or Codex's generated
image directory. Main validates matching identities and bounded raster data URLs;
transport and cancellation use the existing window lease. Image bytes are fetched
separately from bounded transcript pages, with no renderer networking or CSP change.

## Disconnected workspace recovery

The renderer retains same-machine display state while scope-bound operations
remain invalid. It reconciles bounded durable windows before rebinding resource
IDs, and only never-dispatched local writing leaves its bounded outboxes. Main journals waiting writing through two named,
trusted-window operations, independent of backend readiness. A configuration
identity rejects stale saves after SSH destination changes. It writes a private
`remote-settings.json.waiting-writing.json` sidecar so earlier desktop releases
retain their unchanged settings format. A durable sending claim precedes
dispatch; relaunch restores such claims as unknown. No renderer storage or
credential persistence is introduced.
Dispatched prompts and mutations never replay on connection recovery. Unknown
prompt outcomes use a read-only durable-receipt check plus explicit inspection.
New backend `taskRequests: true` capability adds `workspaceTaskRequest(scope,
{repoId, requestId})`, mapped to GET `desktop-workspace/task-requests`. Main checks
the trusted sender, current scope, bounded request ID, repository ID and response
ownership. The backend uses the existing unique task-request index, returning a
single task or null without performing setup. Older engines omit the capability.

Automatic SSH retries stop after ten minutes of transient outage. Wake and
bounded main-owned network-interface/online-state observation resume that stop;
authentication and host-trust failures always require a person. Existing
main-owned transport credentials, CSP and the named bridge remain unchanged.

Remote Browser viewer routes require the managed private IPC transport and a
rotated exclusive viewer lease; they are unavailable on the legacy TCP API. Main
owns credentials, frame transport and narrowly typed input. The renderer does
not fetch remote frames or expose pixels to MCP. Disconnect invalidates driver
generations and queued work; metadata reconciliation never replays an action.
See [the browser host](../apps/backend/src/desktop-browser/README.md).
## User terminal slice

Terminal replies optionally carry `portDiscovery` and at most 16 `services`.
New engines discover actual process-owned TCP listeners using bounded,
demand-driven OS snapshots shared across windows/tasks. Output URLs only refine
protocol/path hints; they never establish a listener. The primary `port` and
`protocol` fields remain compatible. Main validates loopback addresses and
canonical paths, and rechecks the selected generation/port through the additive
bounded `GET terminals/:id/service` before browser opening. Older engines retain
their existing handoff. No new IPC operation, network permission or generic
renderer request is introduced. See the
[collector ownership and platform limits](../apps/backend/src/user-terminal/ports/README.md).

Shell integration is optional. New engines advertise `shellIntegrationControl`
on terminal lists and accept an optional boolean `shellIntegration` on creation;
omitting it preserves existing defaults. Per-terminal state is an optional,
runtime-validated enum. Main strips unknown fields and older replies remain
valid. The renderer exposes a plain-shell launch only with the capability.
PTY output, input, geometry, script execution and ownership do not depend on
tracking. See the [adapter boundary and runtime assets](../apps/backend/src/user-terminal/shell-integration/README.md).

Terminal replies may also carry optional `activityTitle` display metadata. The
backend owns command/title lifecycle and saved-name precedence; main bounds and
validates the label, and the renderer updates the existing keyed tab. Standard
OSC titles never authorize execution, service discovery or navigation. Existing
`title` and older consumers retain their original semantics. No new read, mutation
or polling lifetime is introduced for labels.

Rich command metadata uses the optional `commandTracking` capability and the
named `task-terminal:commands` read. Generation/after-ID pages return at most 20
immutable completions and a separate current record; main validates identities,
ordering, bounds and nullability. Retention is process-owned (200 records/128 Ki
text units) and read/reconnect never executes input. Output pages may include
bounded authenticated command-start offsets for local xterm navigation. The
optional observed `currentCwd` is display-only; existing `cwd` keeps its original
launch-workspace semantics. Older engines may omit all of these additions.

The additive `task-terminal:*` bridge preserves bounded HTTP lifecycle/history
operations and capability-selects the ordered `/desktop-terminal/v1` stream.
Named attach/detach, write, resize, focus and acknowledge operations bind a main-owned
WebSocket to the existing per-window backend lease. Renderer events contain only
validated domain packets. Credits span the socket and Electron IPC and are returned
after xterm consumes output. Input is pipelined and never replayed. Scope/document
changes abort both bounded reads and live leases.

Runtime assembly currently reads the edge proxy allowlist from
`apps/frontend/proxy.conf.json`. The shipped allowlist must expose the
`/desktop-terminal` WebSocket prefix, including `/desktop-terminal/v1`.
Rebuild and install the backend runtime to update this allowlist.
Unpackaged desktop launches log bounded WebSocket errors and close codes/reasons
in main's console, with private capability values redacted. These diagnostics
do not enter renderer events or change the no-replay input contract.
Protocol rejection logs use fixed reason codes for packet parsing, delivery,
cursor/generation, snapshot and input-ack validation, with handshake/stream phase;
raw rejected packets and parser errors are never logged. Valid server `closed`
packets also produce bounded, capability-redacted diagnostics.

The PTY manager owns an isolated headless screen worker. Expired cursors restore a
bounded checkpoint instead of treating an arbitrary output tail as complete screen
state. Terminal-generated replies have one server owner, and replay cannot send
historical replies. Main/renderer reject stale identities, process generations,
cursor discontinuities and oversized packets. Older engines retain their HTTP
contract. Per-machine shell/prediction preferences use narrow typed methods and
private desktop storage. See [stream ownership and budgets](../apps/backend/src/user-terminal/stream/README.md)
and [renderer behavior and prediction limits](../apps/renderer/src/app/task-terminal/README.md).

Main stamps terminal creation with an opaque app-launch owner, shared across
windows and absent from renderer arguments. App quit and last-window close send
owner-scoped cleanup before releasing engines/transports; remote cleanup is best
effort when disconnected. Desktop rows are distinct from durable legacy rows and
expire on engine shutdown/startup. Existing clients may omit the owner and retain
engine-lifetime desktop shells. Cleanup waits for pending launches and strict PTY
termination; opening an empty Terminal pane creates a fresh shell through the
existing explicit opening flow. There is no shutdown channel in the preload.

The optional `sessionNestingOrder: true` workspace capability enables
`workspaceSessions` child queries with `childOrder: 'nested'`. This mode orders
by the persisted per-group nesting rank, then session ID. Successful moves append
at the end; repeated moves to the same parent preserve order. Migrated children
have rank zero and retain their ID order. A `(rank, ID)` keyset cursor remains
usable after the cursor row is removed. Pages stay bounded to 100; the renderer
keeps a 20-child window and reloads its latest page after a confirmed move.
Omitting the option preserves existing flat/root/child ordering and numeric
cursors. Main validates the opt-in mode and its bounded cursor without changing
other resource pagination. Older engines keep the group highlight and keyboard
moves; the renderer withholds the dock's append-position promise.

The optional `browserElements` chat capability advertises native-image element references. Browser state optionally supplies `elementSnapshots: 1` and `capturePending`; older engines remain usable. Explicit human captures cross the existing task-owned browser boundary as bounded raster snapshots, then the existing scoped upload/send pipeline. A versioned prompt envelope associates each stable reference with its exact attachment filename and one-based native image input. No renderer networking or generic IPC capability is added. See [the visual-element contract](browser-element-mentions.md) for lifetime, stale-document and recovery behavior.

### Reply change review

Turn capture lives in the backend, with one advisory filesystem observer per
canonical checkout. A read-only Git inventory and file preimages establish the
starting state. A second inventory and targeted content reads compare net worktree
versions, including new untracked files and changes committed during the turn.
When the checkout's recent HEAD reflog identifies a rebase within the capture
window, turn and shell comparisons omit the revision switch and commit replay.
Dirty paths and commits made before or after the rebase remain candidates for
review. Edits after the rebase use the rebased content as their preimage on
paths without earlier edits. If the reflog cannot establish the rebase
boundaries, capture uses the ordinary endpoint comparison.
The implementation leaves the real index, branches, refs and Git objects alone.
The workspace Git Changes panel continues to read the checkout directly, including
edits from outside the active session. Observed writes coalesce cache
invalidations while the configured refresh still catches external edits when
there is no active observer.

Codex app-server contributes completed `fileChange` deltas after thread and turn
matching. Claude's SDK hooks contribute successful editor receipts and native
`bashEditDiff` observations. Pi edit receipts and OpenCode edit or patch receipts
contribute native diffs when available. All four harnesses use tool lifecycle
events for bounded observations. Known editor paths are sampled individually.
Shell windows compare known dirty paths and paths reported by the observer.
Postimages are captured before Git preimage lookup or diff rendering. Matching
provider and observed editor diffs appear once. Differing observations for the
same shell call and file keep both versions with their sources labeled.

The turn comparison covers incomplete windows, tools without lifecycle events,
and older engines with sparse events. Overlapping sessions can share net and
tool observations while completed provider receipts retain their tool identity.

Captures save bounded inline patches and compact summaries. Desktop transcript
windows load summaries, and the authorized reply review hydrates one capture on
demand. Paths, lines, command preimages, observer journals and Git output are
bounded. Binary and oversized files may have metadata only. Ignored directory
preimages, background commands and missed filesystem notifications can limit
command review. A rename in net review is represented by the paths that were
removed and added; an explicit Codex move also retains its source and destination
in provider review.
