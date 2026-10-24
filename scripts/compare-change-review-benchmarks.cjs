#!/usr/bin/env node
// Usage: node scripts/compare-change-review-benchmarks.cjs BEFORE.json AFTER.json OUTPUT.json [TUNED.json] [BEFORE_REPEAT.json] [AFTER_REPEAT.json]
const fs = require("node:fs/promises");
const path = require("node:path");
function percentile(values, q) {
  const sorted = values.filter((value) => value != null).sort((a, b) => a - b);
  return (
    sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * q) - 1)] ??
    null
  );
}
function summarize(result) {
  const samples = result.samples;
  return {
    rounds: samples.length,
    errors: samples
      .filter((sample) => sample.error)
      .map((sample) => sample.error),
    p50Ms: result.p50Ms,
    p95Ms: result.p95Ms,
    gitProcessesP50: result.gitP50,
    nodeStatCallsP50: result.statP50,
    nodeBytesReadP50: result.bytesP50,
    nodeIndexCopiesP50: percentile(
      samples.map((sample) => sample.indexCopies),
      0.5,
    ),
    nodeIndexCopyBytesP50: percentile(
      samples.map((sample) => sample.indexCopyBytes),
      0.5,
    ),
    childProcessStdoutBytesP50: percentile(
      samples.map((sample) => sample.gitOutputBytes),
      0.5,
    ),
    cacheHitsP50: result.hitsP50,
    eventLoopP95Ms: percentile(
      samples.map((sample) => sample.eventLoopP95Ms),
      0.95,
    ),
    queueMeanDelayP50Ms: percentile(
      samples.map((sample) => sample.queueMeanDelayMs),
      0.5,
    ),
    peakRssBytes: Math.max(...samples.map((sample) => sample.peakRss)),
    peakHeapBytes: Math.max(...samples.map((sample) => sample.peakHeap)),
    retainedHeapAfterGcP50Bytes: percentile(
      samples.map((sample) => sample.retainedHeapAfterGc),
      0.5,
    ),
    maxRetainedReviewCacheBytes:
      Math.max(...samples.map((sample) => sample.retainedCacheBytes ?? 0)) ||
      null,
    peakScheduledGitProcesses:
      Math.max(...samples.map((sample) => sample.queue?.peakActive ?? 0)) ||
      null,
    peakScheduledGitProcessesPerRepository:
      Math.max(
        ...samples.map((sample) => sample.queue?.peakRepositoryActive ?? 0),
      ) || null,
  };
}
async function main() {
  const [
    beforePath,
    afterPath,
    output,
    tunedPath,
    beforeRepeatPath,
    afterRepeatPath,
  ] = process.argv.slice(2);
  if (!output)
    throw new Error("Expected BEFORE.json AFTER.json OUTPUT.json [TUNED.json]");
  const before = JSON.parse(await fs.readFile(beforePath)),
    after = JSON.parse(await fs.readFile(afterPath));
  if (before.benchmarkSha256 !== after.benchmarkSha256)
    throw new Error("Benchmarks must use the same harness");
  const tuned = tunedPath ? JSON.parse(await fs.readFile(tunedPath)) : null;
  const beforeRepeat = beforeRepeatPath
    ? JSON.parse(await fs.readFile(beforeRepeatPath))
    : null;
  const afterRepeat = afterRepeatPath
    ? JSON.parse(await fs.readFile(afterRepeatPath))
    : null;
  for (const [repeat, original] of [
    [beforeRepeat, before],
    [afterRepeat, after],
  ]) {
    if (
      repeat &&
      (repeat.benchmarkSha256 !== original.benchmarkSha256 ||
        JSON.stringify(repeat.moduleHashes) !==
          JSON.stringify(original.moduleHashes))
    )
      throw new Error(
        "Repeat measurements must use the same harness and build",
      );
  }
  if (
    tuned &&
    (tuned.benchmarkSha256 !== after.benchmarkSha256 ||
      JSON.stringify(tuned.moduleHashes) !== JSON.stringify(after.moduleHashes))
  )
    throw new Error(
      "Tuning comparison must use the identical harness and implementation",
    );
  const report = {
    generatedAt: new Date().toISOString(),
    baselineCommit: before.sourceCommit,
    implementation:
      "Uncommitted working tree based on baselineCommit; module hashes identify both builds",
    benchmarkSha256: after.benchmarkSha256,
    toolVersions: {
      node: after.node,
      git: after.git,
      simpleGit: after.simpleGit,
      typescript: after.typescript,
    },
    machine: { platform: after.platform, cpu: after.cpu },
    fixture: after.fixture,
    configuration: after.config,
    methodology: [
      "Disposable repositories, isolated user/system Git configuration, no PR or network lookup, optional locks disabled.",
      "Baseline was compiled before production edits. Final paired runs use identical harnesses and sequential, separate Node processes with --expose-gc.",
      "Cold means summary/scope and status cache invalidation; repository identity can remain warm after the first round. Disk/page caches are not dropped.",
      "p95 uses nearest rank over 5, 7 or 11 samples; small diagnostic samples are not production performance guarantees.",
      "Runs are sequential but the machine is not isolated from other workloads. Supplementary same-build runs are retained to expose between-run timing variability; process/stat counts are more stable than latency.",
      "Status polls advance Date.now by five seconds per sample without sleeping. This exercises authoritative expiry and periodic ref verification independently of numstat/divergence reuse.",
      "Node stat calls count instrumented promise-based stat and lstat API calls. Callback/synchronous APIs and filesystem operations inside Git are not counted. Node bytes include readFile and streamed data. Child stdout bytes (raw key gitOutputBytes) include Git and any environment helper output.",
      "Disposable index copies are reported separately as logical copy bytes. Their size-accounting stat is measurement overhead excluded from the Node stat counter. Memory covers the Node worker, excluding child Git RSS.",
      "Cache hits count successful row/line/context/summary getters, not all internal caches. Baseline has no byte accounting or scheduler instrumentation; null means unavailable.",
      "Queue delay is mean scheduled Git-operation wait per request, summarized at p50. Peak scheduled process counts are cumulative within each worker. Unit tests exercise full scheduler capacity and cancellation.",
      "Event-loop delay is sampled at 1ms; RSS/heap peaks at 2ms plus end-of-request memory. Retained heap is after explicit GC, outside request timing. Peak RSS includes earlier workloads in the same worker.",
      "eventLoopP95Ms is the nearest-rank p95 of individual requests' p95 event-loop delays, rather than a pooled histogram.",
      "Phases add 300 untracked files, a linked worktree/branch, 200 renames, 1.5MB historical/current files and sixteen 270KB untracked files. Ref updates move existing origin/main commits locally; correctness tests also perform actual local fetches.",
      "Forced file output is bounded after optimization, so its success/size and memory are not directly equivalent to an unbounded or failed baseline request.",
      "The restored-untracked workload asserts final-tree correctness. Baseline errors there represent the pre-existing deleted-file result, rather than comparable successful requests.",
    ],
    changes: [
      "Complete status/fingerprint/scannedAt snapshots, 1500ms authoritative rescan deadline, coalesced validations, generation-safe publication, shared per-path sizes/versions.",
      "Fixed-path per-worktree HEAD/index reads and shared common-directory refs/objects; periodic HEAD verification, packed-ref verification, no hot branch enumeration or network lookup.",
      "Per-file lookup versions, old/new blob and worktree identities, modes, paths and render options; immutable blob reuse across commits/worktrees; obsolete mutable file artifacts discarded.",
      "Restored deleted/renamed comparison sources use a disposable copied index, including split-index and NUL-path handling. Final worktree content can cancel a deletion or become a modification without changing the repository index.",
      "One combined raw/numstat traversal with tested NUL/rename framing; rename candidate limit 200, conservative incomplete-detection metadata and guard counts.",
      "Staged stats cached by HEAD/index, unstaged stats by index/path fingerprint, untracked stats shared between services, divergence by repository/shallow version and resolved commit pair.",
      "Global Git/stat/content/render queues, per-repository limits, visible-file priority and aging, canceled HTTP waiters preserve shared builds, lifecycle cache release.",
      "Small cached metadata strings are copied from Git output; cache accounting includes the full backing texts retained by sliced rows, file lines and context windows.",
      "Historical/current size guards, 8MiB forced content, 16MiB process output, 15s process budgets, 20000-file forced summaries, 50000-row rendering and incremental patch/inline processing.",
      "CPU-guided row hashing batches the existing serialization into 256-row inputs and yields between batches; in-flight render allocations have an independent shared budget.",
    ],
    cacheBudgetsBytes: {
      reviewRowsContentAndSummaries: 64 * 1024 * 1024,
      selectedPathMetadata: 4 * 1024 * 1024,
      statusSnapshots: 16 * 1024 * 1024,
      packedRefs: 16 * 1024 * 1024,
      sharedUntrackedStats: 8 * 1024 * 1024,
      statusService: 8 * 1024 * 1024,
    },
    reproductionCommands: [
      'REVIEW_BENCH_REPO="$PWD"',
      'REVIEW_BENCH_ROOT="$(mktemp -d)"',
      'mkdir -p "$REVIEW_BENCH_ROOT/baseline-src"',
      `git archive ${before.sourceCommit} | tar -x -C "$REVIEW_BENCH_ROOT/baseline-src"`,
      'ln -s "$REVIEW_BENCH_REPO/apps/backend/node_modules" "$REVIEW_BENCH_ROOT/baseline-src/apps/backend/node_modules"',
      `SOURCE_COMMIT=${before.sourceCommit} node "$REVIEW_BENCH_ROOT/baseline-src/scripts/generate-build-info.js"`,
      'node apps/backend/node_modules/typescript/bin/tsc -p "$REVIEW_BENCH_ROOT/baseline-src/apps/backend/tsconfig.build.json" --outDir "$REVIEW_BENCH_ROOT/before" --incremental false',
      "node scripts/generate-build-info.js",
      'node apps/backend/node_modules/typescript/bin/tsc -p apps/backend/tsconfig.build.json --outDir "$REVIEW_BENCH_ROOT/after" --incremental false',
      'NODE_PATH="$REVIEW_BENCH_REPO/apps/backend/node_modules" node --expose-gc scripts/benchmark-change-review.cjs "$REVIEW_BENCH_ROOT/before" "$REVIEW_BENCH_ROOT/before.json"',
      'NODE_PATH="$REVIEW_BENCH_REPO/apps/backend/node_modules" node --expose-gc scripts/benchmark-change-review.cjs "$REVIEW_BENCH_ROOT/after" "$REVIEW_BENCH_ROOT/after.json"',
      'NODE_PATH="$REVIEW_BENCH_REPO/apps/backend/node_modules" node --expose-gc scripts/benchmark-change-review.cjs "$REVIEW_BENCH_ROOT/after" "$REVIEW_BENCH_ROOT/tuned.json" --tune',
      'node scripts/compare-change-review-benchmarks.cjs "$REVIEW_BENCH_ROOT/before.json" "$REVIEW_BENCH_ROOT/after.json" "$REVIEW_BENCH_ROOT/comparison.json" "$REVIEW_BENCH_ROOT/tuned.json"',
    ],
    concurrency: {
      gitGlobal: 8,
      gitPerKnownRepository: 4,
      statGlobal: 32,
      statPerRepository: 16,
      contentHashGlobal: 4,
      contentHashPerRepository: 2,
      renderGlobal: 8,
      renderPerRepository: 4,
      queuedTasksPerScheduler: 2048,
    },
    limitsAndFollowup: [
      "Cache byte sizes are conservative estimates of retained values; V8 heap/RSS also include in-flight buffers, runtime objects and allocator retention. Small metadata maps retain entry caps.",
      "New paths and previously clean files are discovered by the next requested authoritative status scan after the 1500ms deadline. There is no background scan when idle. Selected cached files receive immediate path-version checks.",
      "On-disk refs use fixed-path reads on every request. Reftable and oversized packed refs use a Git fallback; the accelerated warm path was measured with files-format refs.",
      "Guard probes still use a separate filename traversal to avoid calculating line counts for blocked change sets. Limited rename detection reports a conservative upper bound.",
      "File content and Git output remain bounded buffered reads. True streaming row indexes, lazy context paging, progressive summary counts and a persistent cat-file worker remain follow-up work; warm windows already run no Git processes.",
      "Shared Git builds finish within operation budgets after a client disconnects; cancellation detaches obsolete consumers without killing work needed by another request.",
      "Authoritative status scans still collect dirty-path versions. Warm windows avoid that work between scans; a request that triggers the absolute rescan deadline can pay for one status/fingerprint scan.",
      "Cache-size accounting still runs synchronously under the row/byte limits. Row hashing yields between 256-row batches. Event-loop p95 sampling can miss short stalls; further CPU profiles can guide worker extraction.",
      "Git tuning is opt-in for disposable benchmark fixtures only. Production repository configuration and automatic maintenance are unchanged.",
      "Git numstat/rename processing remains buffered inside bounded-duration child processes; child Git allocation peaks are not capped or measured by this harness. Deferred summary statistics remain follow-up work for extreme blobs.",
    ],
    references: [
      "https://git-scm.com/docs/git-diff",
      "https://git-scm.com/docs/git-status",
      "https://git-scm.com/docs/git-cat-file",
      "https://git-scm.com/docs/git-config",
      "https://git-scm.com/docs/git-maintenance",
      "https://git-scm.com/docs/git-update-index",
    ],
    comparisons: before.results.map((result, i) => ({
      workload: result.name,
      before: summarize(result),
      after: summarize(after.results[i]),
    })),
    tuning: tuned
      ? {
          configuration: tuned.config,
          comparisons: tuned.results.map((result, i) => ({
            workload: result.name,
            default: summarize(after.results[i]),
            tuned: summarize(result),
          })),
        }
      : null,
    repeatability:
      beforeRepeat || afterRepeat
        ? before.results.map((result, i) => ({
            workload: result.name,
            baselineP50RangeMs: beforeRepeat
              ? [result.p50Ms, beforeRepeat.results[i].p50Ms].sort(
                  (a, b) => a - b,
                )
              : null,
            optimizedP50RangeMs: afterRepeat
              ? [after.results[i].p50Ms, afterRepeat.results[i].p50Ms].sort(
                  (a, b) => a - b,
                )
              : null,
            ...(beforeRepeat
              ? { supplementalBefore: summarize(beforeRepeat.results[i]) }
              : {}),
            ...(afterRepeat
              ? { supplementalAfter: summarize(afterRepeat.results[i]) }
              : {}),
          }))
        : null,
    raw: {
      before,
      after,
      ...(tuned ? { tuned } : {}),
      ...(beforeRepeat ? { beforeRepeat } : {}),
      ...(afterRepeat ? { afterRepeat } : {}),
    },
  };
  await fs.mkdir(path.dirname(path.resolve(output)), { recursive: true });
  await fs.writeFile(output, JSON.stringify(report, null, 2) + "\n");
  console.table(
    report.comparisons.map((row) => ({
      workload: row.workload,
      beforeP50: row.before.p50Ms.toFixed(1),
      afterP50: row.after.p50Ms.toFixed(1),
      beforeP95: row.before.p95Ms.toFixed(1),
      afterP95: row.after.p95Ms.toFixed(1),
      beforeGit: row.before.gitProcessesP50,
      afterGit: row.after.gitProcessesP50,
      beforeStats: row.before.nodeStatCallsP50,
      afterStats: row.after.nodeStatCallsP50,
      errors: row.after.errors.length,
    })),
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
