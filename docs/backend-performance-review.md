# Backend reliability and performance review

Original reviewed revision: `d1293c35ad720fe5874b1bc5bc60b5c41959365f` (2026-10-23).

## Integration verification

All 17 feature branch histories listed below are integrated in
`99bf7e14997ea30b38cd1410023f8f063c7e82bc`. The integration preserved the original
commits and applied without conflicts. The final review found and fixed an
additional status race: after stage, unstage, or commit completed, a new reader
could still join a pre-mutation summary waiting for remote metadata. Three real
Git regressions failed before the correction and passed afterward. Mutations now
detach both normal and conflict-only pending summaries; older callers can finish
without deleting replacement requests.

Final validation on that executable revision:

- **161 backend suites and 2,521 tests passed**, eight tests skipped, in 214.466 s.
- All **six native PTY/tmux integration tests passed** separately. The other two
  skipped tests require explicitly configured live Codex integration.
- Production TypeScript compilation passed with incremental compilation disabled.
- The Electron backend and Pi extension bundled successfully; the backend bundle
  passed `node --check`.
- Both the production build and Electron bundle passed seven real HTTP smoke
  checks each: startup, 16 concurrent workspace reads, 32 concurrent Git summaries,
  stage/commit and review invalidation, GitHub empty state, atomic project-owned
  reorder rejection, and startup migration plus SQLite integrity/foreign keys.
- pnpm 8.15.4 accepted the manifests and v6 lockfile in offline frozen
  lockfile-only mode. Installed dependencies were reused read-only; this is not a
  claim of a fresh native dependency rebuild.

The repeatable harnesses are
[`benchmark-backend-performance.cjs`](../scripts/benchmark-backend-performance.cjs)
and [`smoke-backend-performance.cjs`](../scripts/smoke-backend-performance.cjs).
The smoke harness uses a disposable repository, database, OS-home projection,
and loopback port; it does not operate on the user's application database.
Both harnesses isolate inherited Git plumbing/configuration from fixture writes.
Raw local logs and Jest JSON are in `artifacts/backend-performance-review/`.
The committed [validation evidence](backend-performance-validation.json) records
source and compiled-module hashes, branch ancestry, test totals, smoke checks,
and every benchmark timing sample.

## Measured performance

The comparison executes the baseline and final compiled services on macOS arm64,
Node 24.12.0, against the same generated Git repository: **12,001 tracked files,
2,400 dirty files, 1,200 staged files, 601 branches and 601 commits**. Files are
small text fixtures; this is not a production-sized object database. There are
seven rounds per burst workload and nine per serial/CPU workload. Two passes run
in opposite revision order, in separate processes with warmed OS caches. Git
process counts come from `GIT_TRACE2_EVENT`; all filesystem and Git work is real.
GitHub CLI responses are simulated with a fixed 25 ms delay; no live GitHub
throughput or network-latency claim is implied. Shared public outputs compare
equal in every workload (the resolver's newly added internal `headSha` field is
excluded from its baseline comparison).

| Workload                              | Baseline median, two passes | Final median, two passes | Work per round                                                            |
| ------------------------------------- | --------------------------- | ------------------------ | ------------------------------------------------------------------------- |
| 32 concurrent full status reads       | 7,022 / 7,055 ms            | 407 / 398 ms             | 161 → 6 Git processes; **17.3–17.7× faster**                              |
| 32 concurrent conflict-only reads     | 2,251 / 2,240 ms            | 149 / 146 ms             | 96 → 3 Git processes; **15.1–15.4× faster**                               |
| 32 concurrent GitHub context reads    | 1,237 / 1,261 ms            | 91 / 94 ms               | 160 → 6 Git processes; **13.4–13.5× faster**                              |
| 32 concurrent missing-PR reads        | 2,454 / 2,463 ms            | 119 / 120 ms             | 320 → 6 Git processes; **32 → 1 simulated GitHub CLI calls**              |
| Map 20,000 staged additions, CPU only | 354 / 346 ms                | 5.51 / 5.44 ms           | Identical sorted output; **63.7–64.2× faster**                            |
| One warm full status read             | 338 / 340 ms                | 337 / 406 ms             | Similar Git work; no consistent improvement; second pass about 19% slower |
| One warm positive PR read             | 0.003 / 0.003 ms            | 93.6 / 93.2 ms           | 0 → 6 local Git processes; zero GitHub CLI calls in both revisions        |

The last row is a measured cost of correctness: the old path-only cache could
return another branch's PR for ten seconds after checkout. The final service
checks current branch, HEAD, upstream and remote identity before reusing cached
PR data. That adds approximately 93 ms on this host. A future lightweight ref
snapshot could reduce this overhead, but would need to handle packed refs,
linked worktrees, configuration includes and mutation invalidation correctly.
The 32-request concurrency gains and reduced external work are clear; serial
warm reads are not universally faster. These are measured local medians, not a
production p95 guarantee or a benchmark of hundreds of simultaneous checkouts.

To reproduce, compile the original revision and final revision with the same
locked dependency versions, then run the harness with their respective `dist`
directories. The original source used here was archived from `d1293c3`; the final
production build was compiled from `99bf7e1` with incremental compilation disabled.

```sh
node scripts/generate-build-info.js
./apps/backend/node_modules/.bin/tsc --incremental false -p apps/backend/tsconfig.build.json
(cd apps/backend && ./node_modules/.bin/jest --runInBand --silent --testTimeout=30000)
(cd apps/backend && ELEVENEX_PROCESS_TESTS=1 ./node_modules/.bin/jest --runInBand --testPathPatterns=process-lifecycle.integration)
node scripts/bundle-electron-backend.js
node --check apps/backend/bundle/main.cjs
node scripts/smoke-backend-performance.cjs
ELEVENEX_BENCHMARK_BASELINE_REF=d1293c35ad720fe5874b1bc5bc60b5c41959365f \
  node scripts/benchmark-backend-performance.cjs \
  /path/to/baseline/apps/backend/dist apps/backend/dist \
  artifacts/backend-performance-review/benchmarks
```

The HTTP smoke checks cover a repository without a GitHub remote. Live GitHub
authentication/PR integration and live agent-provider execution remain outside
this validation. The local Claude CLI also reported a pre-existing version
mismatch (installed 2.1.278; SDK expects 2.1.296), so this report does not claim
to have verified that provider combination end to end.

The review covers the backend's module boundaries, expensive request paths,
resource ownership, cancellation, cache invalidation, database writes, and error
reporting. This is an architectural review plus targeted source and regression
testing, not a claim of exhaustive line-by-line verification or zero remaining
bugs. The backend contains approximately 111,000 lines including tests.

## Independent review branches

All implementation branches start at the original reviewed revision. Each task
retains its implementation conversation and validation results; the branch
histories are now combined in the integration revision above.

| Task | Branch                                 | Changes                                                                                                                                                           |
| ---- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 122  | `perf/review-backend-and-optimize`     | GitHub request coalescing, branch/HEAD/remote-sensitive caches, negative caching, bounded retention, shared repository snapshots; this report                     |
| 123  | `perf/backend-git-status`              | Coalesce whole status requests, bound remote fallback, avoid branch enumeration and quadratic status mapping                                                      |
| 124  | `fix/backend-change-review-cache`      | Refresh review bases after commits/checkouts/fetches, coalesce expensive reads, prevent stale cache publication, cheap change counting                            |
| 125  | `fix/backend-git-cache-races`          | Identity-safe fingerprint and branch cache invalidation, mutation-time refresh, branch validation and cheap short-query handling                                  |
| 126  | `fix/backend-files-and-watchers`       | Safe rename/containment/path decoding, watcher reconnect ownership, transient registration writes, bounded Unicode-correct search processing                      |
| 127  | `fix/backend-process-lifecycle`        | At-most-once saved actions, process-specific termination, bounded log reads/retention, startup/delete ownership                                                   |
| 128  | `fix/backend-agent-lifecycle`          | Balanced client attachment, Pi startup/exit ownership, Claude hook reactivation, transcript watcher teardown, standby cleanup                                     |
| 129  | `fix/backend-generation-deadlines`     | Cancel and bound helper generation, drain subprocess output, recover interrupted context generation and reject superseded outcomes                                |
| 130  | `fix/backend-workspace-state`          | Reuse workspace scans and worktree listings, atomic default workspace creation, validate checkout identity before release, conservative failed observations       |
| 131  | `fix/backend-mcp-resources`            | Cancellable transcript search outside the main thread, bounded output, cancelled human requests, MCP connection expiry/shutdown                                   |
| 132  | `fix/backend-project-ordering`         | Project-scoped atomic todo/scratchpad reorder operations and maximum-based order allocation                                                                       |
| 133  | `fix/backend-proxy-cancellation`       | Propagate HTTP/WebSocket disconnects and stream failures; bound slow-client WebSocket queues                                                                      |
| 134  | `fix/backend-codex-turn-isolation`     | Filter stale Codex turn events, preserve transient resume errors, cancel OpenCode prompt preparation, expose unconfirmed stops and avoid replaying uncertain work |
| 135  | `fix/backend-session-helper-lifecycle` | Absolute Q&A/setup deadlines, inherited-answer exclusion, safe embedded-chat deletion, responsive prompt acceptance and explicit paused-queue recovery            |
| 136  | `fix/backend-speech-lifecycle`         | Cloud speech deadlines/disconnect cancellation and serialized local model inference/removal/shutdown                                                              |
| 137  | `perf/backend-shell-environment`       | Bound concurrent login-shell environment capture, prioritize interactive captures, cap output and clean subprocess groups                                         |
| 138  | `fix/backend-change-capture`           | Correct Git path handling during turn capture and make integration-test dependencies portable                                                                     |

## Architecture retained

The existing provider registry, async Git operations, durable task leases, release
validation, coalesced repository fetches, and bounded MCP discovery are useful
foundations. The changes strengthen their ownership and reuse rather than replace
the backend with a new framework. Frontend redesign work is outside this review.

For expensive reads, concurrent requests should share a promise, invalidation must
detach the old promise, and completion must verify ownership before publishing or
removing anything. The same rule applies to watchers, subprocesses, native agent
turns, and background generation. A timeout must terminate or cancel the underlying
work where supported; merely abandoning its result is insufficient.

Workspace and repository summaries should reuse one enumeration and one status
snapshot per canonical checkout. Observation failure must remain visible or block
destructive decisions; it must not silently become a clean checkout. Network access
must not indefinitely block local Git status.

Transport limits distinguish legitimate frame sizes from slow-client backlog.
Agent history and runtime snapshots can exceed 1 MiB: their in-flight allowance
must remain finite without causing a permanent hydrate/reconnect loop. Frames
above the supported ceiling return an actionable error on the existing socket.

## Validation and review

Each branch includes focused regressions for the concrete failure scenarios.
Independent source review also checks that the fixes do not introduce replacement
process kills, post-disposal work, per-token polling, or cross-checkout invalidation.

Production compilation uses `tsc --incremental false -p tsconfig.build.json`
after generating build info. The broader test-inclusive TypeScript configuration
already reports numerous errors at the reviewed baseline; those diagnostics must
be distinguished from production compilation and changed-file regressions.

Branch validation:

| Task | Tested commit | Focused validation                                                                                                                                                                                    |
| ---- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 122  | `c80efc1`     | 13 tests; negative caching, concurrency, invalidation, ref changes, expiry, oversized retention                                                                                                       |
| 123  | `137b104`     | 85 tests, including stalled remote helpers and status races; production typecheck                                                                                                                     |
| 124  | `1fd9c2c`     | 40 tests; scoped service/test typecheck                                                                                                                                                               |
| 125  | `aed2492`     | 39 tests; scoped typecheck and lint                                                                                                                                                                   |
| 126  | `7b63b52`     | 193 tests; scoped typecheck                                                                                                                                                                           |
| 127  | `8f88496`     | 79 focused tests, six native PTY/tmux tests, isolated shell-fallback regressions; production/scoped checks                                                                                            |
| 128  | `918504e`     | 231 tests; independent lifecycle review                                                                                                                                                               |
| 129  | `ba16712`     | 74 tests; changed production files checked                                                                                                                                                            |
| 130  | `473a0c4`     | Initial 142 tests; 13 workspace/migration and ten selected lifecycle regressions after repair simplification; production/scoped checks and Drizzle consistency                                        |
| 131  | `bab4d06`     | 150 focused tests; 12 projection regressions and both terminal DB race cases rechecked; production typecheck                                                                                          |
| 132  | `b2549b3`     | 73 tests across six suites, including real SQLite rollback/ownership cases                                                                                                                            |
| 133  | `cda7ba0`     | Initial 73 tests across nine suites; real >2 MiB snapshots, allowance lifecycle and oversize guards; 17 gateway cases after fixture isolation; production/scoped checks                               |
| 134  | `297c29d`     | 110 Codex/runtime tests after retry-safety fix; 51 OpenCode tests after Stop/idle fix; scoped checks and independent review                                                                           |
| 135  | `50b7901`     | 202 tests for helper waits and paused-queue recovery; 158 affected cases after mixed-state priority fix; scoped checks and independent review                                                         |
| 136  | `4246704`     | 126 tests; production and focused typechecks; real cached Whisper inference/shutdown smoke                                                                                                            |
| 137  | `085318e`     | 35 tests; capture priority, capacity, coalescing, timeout and output bounds                                                                                                                           |
| 138  | `822a19a`     | 29 tests across capture, persisted changes and history compression; unusual filenames, inherited Git environment and unchanged index; production compilation and offline frozen-lockfile verification |

For the initial verification, all 17 branch diffs were combined in a temporary checkout from the reviewed
revision using three-way application. They applied without conflicts; the actual
branches were still separate at that stage. That tested tree was
`0108abefa7f3e03076b0843ce2c4b7933fcc1805`; the source commits are listed above.
The report itself was committed afterward without changing executable code.

Initial combined validation on 2026-10-23:

- Production compilation passed in 7.27 seconds.
- The full backend Jest run passed: **161 suites and 2,518 tests**, with two
  suites/eight tests skipped, in 186.46 seconds. Command:
  `jest --runInBand --silent --testTimeout=30000`.
- Six skipped cases are opt-in native PTY/tmux tests already passed separately
  on task 127. The other two require an explicitly configured live Codex binary.
- `node scripts/bundle-electron-backend.js` built the backend and Pi extension;
  `node --check apps/backend/bundle/main.cjs` passed.
- Installed pnpm dependencies were reused read-only in the temporary checkout,
  with the newly declared Express test dependency exposed separately. Task 138
  also verified the tracked pnpm v6 lockfile with pnpm 8.15.4 in offline frozen
  mode.

The full run exposed an existing turn-capture failure: applying
`GIT_LITERAL_PATHSPECS` to every Git command made `check-ignore` fail, preventing
file capture. Task 138 corrects that command handling and tests unusual filenames
and inherited Git environment settings. It also removes an optional Python-shim
dependency from capture tests and declares the previously implicit Express test
dependency. The final full run includes these corrections.

Runtime validation was performed on macOS. Windows process cleanup was covered
with mocks, and most live agent-provider protocol cases were simulated. Git and
filesystem reads are not atomic snapshots. Change-review PR metadata retains its
existing one-hour cache unless explicitly refreshed; GitHub service reads use a
ten-second cache. Remote tracking freshness also depends on fetching. Agent
transport accepts frames up to 32 MiB with 64 MiB of large
frames in flight and 1 MiB of ordinary backlog per client; larger frames return
an error with export/HTTP alternatives rather than repeatedly reconnecting.

## Follow-ups requiring measurement

- Codex history still acquires whole rollout files. Files above the 16 MiB
  transcript-cache admission limit are reread and parsed on subsequent requests;
  append-heavy histories would benefit from measured incremental parsing and a
  bounded history API.
- Conversation delta exports still acquire complete provider history before
  rendering their requested window. Provider-level cursors are a better target
  than optimizing Markdown slicing alone. Paginated UI history should also avoid
  transferring complete transcripts in a single hydration frame.
- OpenCode's global event adapter awaits recovery requests while consuming its
  shared event stream. Measure whether unrelated recovery delays other sessions
  before changing event scheduling.
- Extend the synthetic monorepo measurements above to a representative production monorepo,
  hundreds of branches, simultaneous checkouts, frequent fetched commits, large
  dirty sets, slow remotes, and slow consumers. Regression tests establish
  correctness and bounded work, not a production p95 latency claim.
