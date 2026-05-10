# Claude Runtime: Persistent Query Migration

## Goal

Eliminate the per-turn `claude` binary spawn from the Claude provider by
running the `@anthropic-ai/claude-agent-sdk` `Query` in its **streaming
input mode** — one long-lived child process per session, fed new prompts
across turns instead of re-spawned for each.

Expected gain: **~200–500 ms shaved from every prompt after the first** in
a session, which is the cost of the `claude` binary's fork+exec and SDK
bootstrap. This mirrors the win the Codex provider already realized by
moving from `codex exec` (one process per turn) to `codex app-server` (one
process per backend). See `apps/backend/src/codex-runtime/codex-app-server.ts`
and the patterns in `apps/backend/src/codex-runtime/codex-runtime.service.ts`
for the analogous design.

The current Claude code path even acknowledges this work hasn't been done —
see the comment in `apps/backend/src/claude-runtime/claude-runtime.service.ts`
on `buildQueryOptions` (around line 3030):

> _"This runtime uses short-lived SDK queries resumed by Claude session id.
> Keeping the last N Claude sessions truly warm would require a separate
> long-lived process/runtime model rather than more tuning at this boundary."_

That is exactly what this document describes.

## Background: why this works without a protocol rewrite

Unlike the Codex case (where we had to speak JSON-RPC to `codex app-server`
directly because the SDK had no equivalent), the Claude Agent SDK already
exposes the persistent-process mode we need. From the SDK type definitions
(`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`):

```ts
export declare interface Query extends AsyncGenerator<SDKMessage, void> {
  interrupt(): Promise<void>;
  streamInput(stream: AsyncIterable<SDKUserMessage>): Promise<void>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  setModel(model?: string): Promise<void>;
  setMaxThinkingTokens(maxThinkingTokens: number | null): Promise<void>;
  applyFlagSettings(settings: Settings): Promise<void>;
  // ... "Only available in streaming input mode."
}

declare function query(args: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: Options;
}): Query;
```

There are two `query()` modes:

- **One-shot mode** — `prompt: string`. The SDK spawns `claude`, runs it to
  completion on that single prompt, exits. **What we use today.**
- **Streaming input mode** — `prompt: AsyncIterable<SDKUserMessage>`. The
  SDK spawns `claude` once, keeps it alive, feeds new `SDKUserMessage`s as
  they're pushed into the iterable, exposes `setModel` / `setPermissionMode`
  / `interrupt` / `applyFlagSettings` for mid-session control. **What this
  migration switches us to.**

We already happen to call `query.setModel(...)`, `query.setPermissionMode(...)`,
and `query.interrupt()` on the active Query mid-run (see the existing
`setSelectedModel` and `setPermissionMode` methods in
`claude-runtime.service.ts` ~line 585–625), so those work today **but only
within the lifetime of a single one-shot Query**. The migration extends
that lifetime across multiple turns.

## Current architecture

### Files

- `apps/backend/src/claude-runtime/claude-runtime.service.ts` — the runtime
  (4777 lines; the relevant call sites are listed below).
- `apps/backend/src/claude-runtime/claude-runtime.types.ts` — types
  (`ClaudeRuntimeState`, etc.).
- `apps/backend/src/claude-runtime/claude-runtime.module.ts` — NestJS
  wiring.
- `apps/backend/src/agent-runtime/...` — the provider/gateway plumbing that
  invokes this service. Not changing.

### What happens today on every `submitPrompt`

1. We read the session row (`sessionsService.findOne`).
2. We build `Options` via `buildQueryOptions(...)` — model, permissionMode,
   `resume: claudeSessionId`, etc.
3. We call `query({ prompt: <string or AsyncIterable>, options })` →
   the SDK spawns a fresh `claude` child process.
4. We `for await (const message of runtimeQuery)` to consume events.
5. On turn completion: `run.query.close()` → SDK kills the child.

This loop pays the spawn cost on every turn. The key existing call sites:

- Spawning the query: `runtimeQuery = query({...})` at lines ~961 and ~3092
  (the second is `generateSessionTitle`, which we leave alone — see "Out of
  scope" below).
- Event consumption: `for await (const message of runtimeQuery)` at line
  ~1066.
- Active-run record: `ActiveRunState` interface at line ~153, stored in
  `this.activeRuns: Map<number, ActiveRunState>` at line ~349.
- Interrupt: `await run.query.interrupt()` at line ~4641, followed by
  `run.query.close()`.
- Cleanup on turn end: `run?.query.close()` at line ~1099, then
  `this.activeRuns.delete(sessionId)`.
- Mid-run model / permission changes: `await activeRun.query.setModel(...)`
  at line ~595; `await activeRun.query.setPermissionMode(...)` at line ~620.
- Queued prompts: `state.pendingPrompts` drained at line ~1116 by
  recursively calling `submitPrompt` after the previous turn ends.

## Target architecture

One persistent `Query` per session, owned by a new
`ClaudeSessionRuntime` (one instance per `sessionId`) that:

- Holds a controllable `AsyncIterable<SDKUserMessage>` (a "prompt queue") it
  passes as `prompt` to `query({...})` exactly once.
- Reads messages from the `Query` async generator forever (until torn
  down), routing them through the existing `handleSdkMessage` pipeline.
- Exposes high-level methods that the existing `ClaudeRuntimeService` calls
  per turn instead of constructing a new `Query`:
  - `submitTurn(prompt: string, images?: ClaudeImageInput[]): Promise<void>` —
    pushes one user message into the prompt queue, returns when the turn
    completes.
  - `setModel(model?: string)`, `setPermissionMode(mode)`,
    `applyFlagSettings(settings)`, `interrupt()`, `close()` — proxies to
    the underlying `Query`.

### Why per-session and not global

Each `Query` is bound to a Claude Code session (transcript file, MCP
servers, hook state, permission state). Sharing one across sessions is not
possible without forking sessions out of band. **The Codex case got a
single shared `codex app-server` because codex's app-server protocol is
multi-thread; the Claude SDK is single-session-per-process.** So expect
one persistent `claude` process per open Claude session.

### Lifecycle

Same shape as `CodexAppServerClient` — refcounted with idle shutdown —
but at the per-session granularity:

- **Spawned lazily on first `submitTurn`.** No process while a session has
  zero turns.
- **Stays alive across turns.** Subsequent turns just push into the prompt
  queue.
- **Idle shutdown** after no activity for `IDLE_SHUTDOWN_MS` (recommend
  **5 minutes** — Claude processes are ~150–250 MB each, higher than codex,
  so be more aggressive than codex's 60 s). Any new turn cancels the timer.
- **Crash recovery**: if the child dies unexpectedly, the persistent
  iterator surfaces an error to the in-flight turn, the session runtime is
  marked dead, and the next `submitTurn` spawns a fresh one (which will
  resume the Claude session id from disk via `Options.resume`).
- **Explicit teardown** on `cleanupSession` (session deleted): finish any
  in-flight turn (interrupt if requested), then close.

## Implementation plan

### Step 1 — Add `ClaudeSessionRuntime`

Create `apps/backend/src/claude-runtime/claude-session-runtime.ts`. One
instance per session id. Owns the persistent Query.

Approximate interface (final field names at the implementer's discretion):

```ts
import type {
  Options,
  PermissionMode,
  Query,
  SDKMessage,
  SDKUserMessage,
  Settings,
} from '@anthropic-ai/claude-agent-sdk';

export interface ClaudeSessionRuntimeDeps {
  /** Builds the per-session Options object (same as buildQueryOptions today). */
  buildOptions(initialContext: {
    claudeSessionId: string | null;
    selectedModel: string | null;
    selectedPermissionMode: ClaudePermissionMode | null;
  }): Options;

  /** Called for every SDKMessage the SDK emits. Implementation: existing handleSdkMessage. */
  onMessage(message: SDKMessage): void | Promise<void>;

  /** Called when the SDK message iterator throws or the child dies. */
  onFatal(error: unknown): void;

  /** Called once when the SDK message iterator returns (graceful close). */
  onClosed(): void;

  /** How long to keep the process alive after the last turn. */
  idleShutdownMs?: number;
}

export class ClaudeSessionRuntime {
  constructor(deps: ClaudeSessionRuntimeDeps);

  /** True iff the underlying SDK Query is alive and ready to accept turns. */
  get isReady(): boolean;

  /**
   * Spawn the persistent Query if not yet spawned. Idempotent. Resolves
   * once the Query is created and we've started consuming its messages
   * (i.e. the child has handed back at least the init handshake or the
   * first system message).
   */
  ensureStarted(): Promise<void>;

  /**
   * Push one user message into the prompt queue. The returned promise
   * resolves when the SDK signals end-of-turn for this turn (see
   * "Turn boundary detection" below).
   */
  submitTurn(input: SDKUserMessage): Promise<void>;

  /** Proxy to query.interrupt() — only affects the currently in-flight turn. */
  interrupt(): Promise<void>;
  setModel(model?: string): Promise<void>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  applyFlagSettings(settings: Settings): Promise<void>;

  /**
   * Stop the process. Called by the idle timer, explicit teardown, or
   * a process crash. Safe to call multiple times. Resolves only after the
   * SDK message loop has fully drained.
   */
  close(): Promise<void>;
}
```

**Implementation notes:**

- The "prompt queue" is a pull-based async iterable. Use an internal queue
  + an outstanding waker promise. Typical shape:

  ```ts
  const queue: SDKUserMessage[] = [];
  let waker: (() => void) | null = null;
  let closed = false;

  const iterable: AsyncIterable<SDKUserMessage> = {
    async *[Symbol.asyncIterator]() {
      while (!closed) {
        while (queue.length) yield queue.shift()!;
        if (closed) return;
        await new Promise<void>((r) => { waker = r; });
      }
    },
  };

  function push(msg: SDKUserMessage) {
    queue.push(msg);
    const w = waker; waker = null; w?.();
  }
  function closeQueue() {
    closed = true;
    const w = waker; waker = null; w?.();
  }
  ```

- Pass this iterable as `prompt` to `query(...)`. **Do not recreate it on
  each turn** — that's the whole point.

- After `query(...)` returns, `for await (const m of theQuery)` runs in the
  background for the entire lifetime of the runtime. The async generator
  yields all messages from all turns; turn boundaries are inferred from
  the SDK messages (see below). Wrap this loop in a single try/catch/
  finally that:
  - on error → calls `deps.onFatal(error)` and rejects every in-flight
    turn promise;
  - on normal completion → calls `deps.onClosed()` and resolves any
    in-flight turn promise (this only happens after `closeQueue()`).

### Step 2 — Turn boundary detection

The SDK's stream is continuous; we need to know when a turn ends to
resolve the `submitTurn` promise.

Today, `handleSdkMessage` already infers this — look at how the existing
`finally` block on the for-await loop is reached today (after Claude emits
a `result` system message and the Query closes). With persistent mode the
Query doesn't close per turn, but the SDK still emits the `result` (and/or
`stop_reason`-bearing) messages that mark turn end.

Recommended approach:

- In `submitTurn(input)`, register a single `pendingTurnResolver` before
  pushing the message into the queue.
- The message handler inside `ClaudeSessionRuntime` peeks at every
  `SDKMessage`; when it sees the "this turn is done" signal — concretely a
  message of type `result` (see the existing code path that today triggers
  the for-await loop to exit) — it calls the resolver.
- `interrupt()` should ALSO resolve the pending turn (after the SDK
  acknowledges interrupt) so callers don't hang.

Cross-reference the existing code: `claude-runtime.service.ts` around lines
1066–1119 shows what the SDK emits at end-of-turn today (it's the moment
the for-await loop exits naturally). Mirror that signal.

### Step 3 — Thread `ClaudeSessionRuntime` through `ClaudeRuntimeService`

Add a per-session registry on `ClaudeRuntimeService`:

```ts
private readonly sessionRuntimes = new Map<number, ClaudeSessionRuntime>();
```

Initialize lazily on the first `submitPrompt` for a session and reuse for
subsequent prompts. The runtime is created with deps that wire back into
the existing service methods so we keep one source of truth for event
handling:

```ts
const runtime = new ClaudeSessionRuntime({
  buildOptions: (ctx) => this.buildQueryOptions(
    sessionId,
    worktreePath,
    ctx.claudeSessionId,
    ctx.selectedModel,
    ctx.selectedPermissionMode,
    canUseTool,            // already constructed per session today
    onElicitation,         // already constructed per session today
  ),
  onMessage: (message) => this.handleSdkMessage(sessionId, message),
  onFatal: (err) => this.handleRuntimeCrash(sessionId, err),
  onClosed: () => this.handleRuntimeClosed(sessionId),
  idleShutdownMs: 5 * 60 * 1000,
});
this.sessionRuntimes.set(sessionId, runtime);
```

`canUseTool` and `onElicitation` are session-scoped callbacks that already
live in the runtime today (search for them in `claude-runtime.service.ts`).
They must keep working across turns — they ALREADY do, since they're
closures over `sessionId`, but verify they don't capture any per-turn state
that resets between turns.

### Step 4 — Rewrite `submitPrompt` to use the runtime

Current shape (simplified):

```ts
async submitPrompt(sessionId, prompt, images) {
  // ... queue if active run exists ...
  // ... build options, spawn Query ...
  const runtimeQuery = query({ prompt, options: queryOptions });
  this.activeRuns.set(sessionId, { query: runtimeQuery, ... });
  for await (const msg of runtimeQuery) await this.handleSdkMessage(sessionId, msg);
  // ... cleanup, drain pendingPrompts ...
}
```

New shape:

```ts
async submitPrompt(sessionId, prompt, images) {
  // ... same pendingPrompts queueing if a turn is already in flight ...

  const state = ...; // same as today
  const runtime = await this.ensureSessionRuntime(sessionId, state);

  // Apply any drift between state and runtime config that accumulated
  // while idle (model/permission may have changed via setSelectedModel /
  // setPermissionMode while no turn was running and no Query existed).
  await this.syncRuntimeConfigFromState(runtime, state);

  const userMessage: SDKUserMessage = images?.length
    ? buildMultimodalUserMessage(prompt, images)
    : { type: 'user', message: { role: 'user', content: prompt }, parent_tool_use_id: null };

  this.activeRuns.set(sessionId, { ...newActiveRunState(runtime), runtime });

  try {
    await runtime.submitTurn(userMessage);
  } catch (error) {
    // ... same error path as today (state.lastError, emit error event) ...
  } finally {
    // No query.close() here — runtime is persistent.
    this.activeRuns.delete(sessionId);
    state.canInterrupt = false;
    // ... drain state.pendingPrompts as today ...
  }
}
```

Key delta points:

- **No `query.close()` in `finally`.** The runtime owns the process.
- **`ActiveRunState.query`** can be removed — keep a reference to the
  runtime instead. Methods like `interrupt()` route through it.
- **The for-await loop moves inside `ClaudeSessionRuntime`**; the service
  observes turn boundaries via the `submitTurn` promise.

### Step 5 — Migrate `interrupt`, `setSelectedModel`, `setPermissionMode`

These already call `activeRun.query.{interrupt,setModel,setPermissionMode}`.
Keep the same call signatures, but route through the runtime:

- Interrupt: `runtime.interrupt()`. Resolves the in-flight turn promise.
- Model / permission: `runtime.setModel(...)` / `runtime.setPermissionMode(...)`.
  Still only meaningful when there's an active turn; if there isn't, **cache
  the change on `state` and apply it on the next `submitTurn`** (the
  `syncRuntimeConfigFromState` step above). Today the SDK methods are only
  available when a Query exists; this stays true but the Query lives
  longer, so the "no active query" window is shorter.

### Step 6 — `cleanupSession`

Today: interrupts any active run, drops state. New: also `await
runtime.close()`, `this.sessionRuntimes.delete(sessionId)`.

### Step 7 — Crash recovery

`onFatal` fires when the SDK message iterator throws. Concretely:

1. Reject any in-flight `submitTurn` promise with the error.
2. Drop the runtime from `sessionRuntimes` and any `activeRuns` entry.
3. Mark `state.lastError`, emit an `error` runtime event so the frontend
   sees it.
4. Do **not** auto-respawn. The next `submitPrompt` will spawn fresh — and
   because `buildQueryOptions` always sets `resume: claudeSessionId`, the
   new process resumes the transcript without losing state.

### Step 8 — Idle shutdown

Same shape as `CodexAppServerClient.scheduleIdleShutdown` /
`clearIdleTimer`. Refcount the runtime via `submitTurn` (in: +1, out: -1).
When it hits zero, schedule a `setTimeout(close, idleShutdownMs)`. Any new
`submitTurn` clears the timer.

Recommended `IDLE_SHUTDOWN_MS = 5 * 60 * 1000` (5 minutes). Codex uses
60 s but Claude processes are much heavier (resident memory ~150–250 MB
each, vs ~50–80 MB for `codex app-server`); we don't want hundreds of them
lingering on a workstation that handles many sessions. Make this a module
constant so it's easy to tune.

### Step 9 — Test the multimodal path

`buildMultimodalPromptIterable` (line ~1186) constructs a single-shot
iterable that yields one message. In the new design we don't need an
iterable — `submitTurn` accepts a single `SDKUserMessage`. Move the
"convert (text, images) into SDKUserMessage" logic into a helper:

```ts
function buildSdkUserMessage(text: string, images: ClaudeImageInput[]): SDKUserMessage;
```

Use it for both text-only and multimodal turns. The persistent prompt
queue then handles both uniformly.

## Lifecycle reference (one diagram)

```
session opens (no runtime yet)
   |
   v
first submitPrompt
   |  spawn ClaudeSessionRuntime
   |  spawn `claude` child
   |  ~150–500 ms cold start (one time)
   v
turn 1 streams ... done
   |  runtime alive, child idle
   v
turn 2  (within 5 min)         turn 2  (after 5 min idle)
   |                              |
   |  push to queue               |  runtime was closed by idle timer
   |  no spawn cost!              |  spawn fresh runtime; resume from
   v                              v  claudeSessionId — pays cold start
turn N
   |
   |  user interrupts mid-turn:
   |    runtime.interrupt() -> query.interrupt()
   |    in-flight submitTurn promise resolves
   |    runtime stays alive for next turn
   |
   |  child crashes:
   |    onFatal fires -> reject in-flight turn, drop runtime
   |    next submitPrompt re-spawns + resumes from claudeSessionId
   |
   v
cleanupSession (or app shutdown)
   runtime.close() ->  closeQueue -> SDK ends iteration -> child exits
```

## Edge cases to handle

1. **Concurrent `submitPrompt` calls for the same session.** Today the
   `activeRuns.has(sessionId)` check queues into `state.pendingPrompts`.
   **Keep this guard.** The persistent runtime can only run one turn at a
   time (`streamInput` is sequential and the SDK serializes turns).

2. **Model / permission changed while no turn is in flight.** Today these
   are stamped onto `Options.model` / `Options.permissionMode` at the next
   spawn. With a persistent runtime, the values still need to flow through
   — call `runtime.setModel(...)` / `runtime.setPermissionMode(...)` on
   the next `submitTurn` if the cached state has drifted.

3. **`claudeSessionId` not yet captured on the first turn.** Same as
   today — the first turn creates the session id mid-stream and we persist
   it via `captureClaudeSessionId` (see existing handler). Don't change this.

4. **Backend restart while runtime is alive.** Process group dies with the
   backend. On restart the next `submitPrompt` spawns a fresh runtime and
   passes `Options.resume = claudeSessionId` — Claude's transcript is on
   disk, so this works. No persistent-state cleanup needed.

5. **Frontend reconnect mid-turn.** Today the WS gateway re-broadcasts
   state. Unchanged — the runtime keeps consuming SDK messages and
   broadcasting events; the new WS connection picks up from `runtimeStates`.

6. **`interrupt()` race with end-of-turn.** If the turn naturally ends just
   before `interrupt()` is called, the SDK may reject. The existing code
   has `isIgnorableInterruptedRunError` for this — keep using it.

7. **Permission requests in flight when the user closes the session.**
   `cleanupSession` should still cancel pending permission requests (the
   existing logic in the interrupt path covers this — preserve it).

8. **Pending prompts after a fatal crash.** `state.pendingPrompts` is on
   the runtime state, not the SDK Query. After crash recovery, the next
   `submitPrompt` should still drain them.

## Acceptance criteria

A reviewer should be able to verify all of these:

1. **Latency.** `submitPrompt` → first delta event lands ~200–500 ms
   faster on turn N (N > 1) compared to today, measured against the same
   prompt on the same machine. Use the existing `logStartupTiming` markers
   (`runtime_query_created`, `firstSdkMessageAtMs`) — the
   `queryCreatedToFirstSdkMs` gap should drop dramatically for warm turns.

2. **No regression in transcript fidelity.** The SDK messages stream
   through `handleSdkMessage` exactly as before. All existing
   `claude-runtime.service.spec.ts` tests pass. Run:
   `cd apps/backend && pnpm test claude-runtime.service.spec.ts`.

3. **Interrupt still works.** Interrupting mid-stream stops Claude and
   leaves the runtime ready for the next turn (i.e. **no** child re-spawn
   on the subsequent prompt). Verify by sending two prompts in succession,
   interrupting the first, and confirming the second turn is fast.

4. **Model / permission mode changes still take effect** both mid-turn
   (existing behavior) and between turns when no turn is in flight (new
   path).

5. **MCP, hooks, elicitation, permission requests all still work.** These
   are wired through `canUseTool` / `onElicitation` callbacks that close
   over `sessionId` — they're already lifetime-of-session and will keep
   working. Smoke-test with a tool call.

6. **Resume after backend restart works.** Kill the backend mid-session,
   restart, send a new prompt. Claude resumes the same transcript.

7. **Crash recovery.** Kill the persistent `claude` child (`pkill claude`)
   mid-session; the in-flight turn should error cleanly and the next
   prompt should re-spawn + resume.

8. **Idle shutdown.** After 5 min of no turns, the persistent `claude`
   process exits (verifiable with `ps`). The next prompt re-spawns it.

9. **Build is clean.** No new TS errors in
   `apps/backend && npx tsc --noEmit -p tsconfig.build.json` beyond the
   7 pre-existing ones. No new test failures.

## Out of scope (do not touch in this PR)

- **`generateSessionTitle`** at line ~3092 — one-off short query, not on
  the interactive hot path. Leave it as a one-shot `query({...}).close()`.
- **`startMcpAuthFlow`** at line ~1352 — same, one-off control query.
- **The Codex runtime.** Already done in a prior PR
  (`apps/backend/src/codex-runtime/codex-app-server.ts`) — reference it for
  patterns (idle timer, refcount, crash recovery) but don't modify it.
- **The frontend.** Wire format is unchanged; the WS events emitted by
  `handleSdkMessage` are identical.
- **Subagents, plugins, skills.** They flow through the same SDK message
  pipeline; the migration is transparent to them.

## File-by-file change list

- `apps/backend/src/claude-runtime/claude-session-runtime.ts` — **new**.
  ~250–350 lines. Contains the runtime class, the prompt-queue iterable,
  lifecycle, crash handling.
- `apps/backend/src/claude-runtime/claude-runtime.service.ts` — modify.
  - Add `sessionRuntimes` map and `ensureSessionRuntime` helper.
  - Rewrite the hot path of `submitPrompt` to use `runtime.submitTurn`
    instead of spawning a new `Query`.
  - Re-route `interrupt`, `setSelectedModel`, `setPermissionMode` through
    the runtime; keep their existing "cache change on state if no active
    run" behavior.
  - Add `handleRuntimeCrash` and `handleRuntimeClosed` callbacks.
  - Update `cleanupSession` to `await runtime.close()` after interrupting.
  - Drop `ActiveRunState.query` (replace with a reference to the runtime
    or drop the field if interrupt is routed differently).
- `apps/backend/src/claude-runtime/claude-runtime.types.ts` — minor: any
  type additions needed for the runtime registry / cached state drift.
- `apps/backend/src/claude-runtime/claude-runtime.module.ts` — no changes
  needed unless the runtime is registered as a NestJS provider, which it
  doesn't need to be (one per session, owned by the service).
- Existing tests — verify they still pass; some assertions about
  `query.close()` call counts may need updating since `close()` no longer
  fires per-turn.

## Useful pointers in the existing codebase

For the implementer:

- `apps/backend/src/codex-runtime/codex-app-server.ts` — reference for
  refcount + idle-shutdown lifecycle, single-flight startup, crash
  fan-out to consumers, stdin/stdout error swallow.
- `apps/backend/src/codex-runtime/codex-runtime.service.ts` →
  `runTurnOnAppServer` — reference for a per-turn async generator wrapping
  a long-lived child with a queue + waker, with a synthetic
  `app-server-down` notification for crash recovery.
- `apps/backend/src/claude-runtime/claude-runtime.service.ts` →
  `handleSdkMessage` and friends — the existing event handling that must
  keep working without changes.
- `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` — authoritative
  types for `Query`, `SDKUserMessage`, `Options`, `PermissionMode`. Cross-
  check the `Query` interface starts around line 2017.
