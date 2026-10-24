#!/usr/bin/env node
// Disposable, local-only fixture. Usage: node scripts/benchmark-change-review.cjs DIST OUTPUT.json
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const childProcess = require("node:child_process");
const nodeFs = require("node:fs");
const { execFile, spawn } = require("node:child_process");
const { promisify } = require("node:util");
const { performance, monitorEventLoopDelay } = require("node:perf_hooks");
const exec = promisify(execFile);
for (const key of Object.keys(process.env)) {
  if (
    /^GIT_(DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG.*)$/.test(
      key,
    )
  )
    delete process.env[key];
}
Object.assign(process.env, {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_OPTIONAL_LOCKS: "0",
  SHELL: "/bin/sh",
});
async function git(repo, ...args) {
  return (
    await exec("git", args, { cwd: repo, maxBuffer: 32 * 1024 * 1024 })
  ).stdout.trim();
}
async function fixture(root) {
  const repo = path.join(root, "repo");
  await fs.mkdir(repo);
  await git(repo, "init", "-q", "-b", "main");
  await git(repo, "config", "user.name", "Fixture");
  await git(repo, "config", "user.email", "fixture@example.invalid");
  await git(repo, "config", "gc.auto", "0");
  await git(repo, "config", "core.hooksPath", path.join(root, "no-hooks"));
  for (let dir = 0; dir < 200; dir++) {
    await fs.mkdir(path.join(repo, `p${dir}`));
    await Promise.all(
      Array.from({ length: 30 }, (_, file) =>
        fs.writeFile(
          path.join(repo, `p${dir}/f${file}.txt`),
          "one\ntwo\nthree\n",
        ),
      ),
    );
  }
  await git(repo, "add", ".");
  await git(repo, "commit", "-qm", "initial");
  let input = "";
  for (let i = 1; i <= 1500; i++) {
    const body = `revision ${i}\n`;
    input += `commit refs/heads/main\nmark :${i}\ncommitter Fixture <fixture@example.invalid> ${1700000000 + i} +0000\ndata 5\nchurn\n`;
    if (i === 1) input += "from refs/heads/main^0\n";
    input += `M 100644 inline churn.txt\ndata ${Buffer.byteLength(body)}\n${body}\n`;
    if (i <= 500) input += `reset refs/heads/b${i}\nfrom :${i}\n\n`;
  }
  await new Promise((resolve, reject) => {
    const child = spawn("git", ["fast-import", "--quiet"], {
      cwd: repo,
      stdio: ["pipe", "ignore", "pipe"],
    });
    let error = "";
    child.stderr.on("data", (chunk) => {
      error += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(error)),
    );
    child.stdin.end(input);
  });
  await git(repo, "reset", "--hard", "HEAD");
  await git(
    repo,
    "update-ref",
    "refs/remotes/origin/main",
    await git(repo, "rev-parse", "HEAD"),
  );
  await git(
    repo,
    "symbolic-ref",
    "refs/remotes/origin/HEAD",
    "refs/remotes/origin/main",
  );
  await git(repo, "checkout", "-qb", "feature");
  await git(
    repo,
    "config",
    "remote.origin.fetch",
    "+refs/heads/*:refs/remotes/origin/*",
  );
  await git(repo, "config", "branch.feature.remote", "origin");
  await git(repo, "config", "branch.feature.merge", "refs/heads/main");
  for (let dir = 0; dir < 20; dir++)
    await Promise.all(
      Array.from({ length: 30 }, (_, file) =>
        fs.appendFile(path.join(repo, `p${dir}/f${file}.txt`), "dirty\n"),
      ),
    );
  await git(repo, "add", "p0", "p1", "p2");
  return repo;
}
async function main() {
  const [distArg, outputArg] = process.argv.slice(2);
  if (!distArg || !outputArg) throw new Error("Expected DIST OUTPUT.json");
  const dist = path.resolve(distArg);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "review-bench-"));
  try {
    const repo = await fixture(root);
    const realNow = Date.now;
    let clockAdvance = 0;
    Date.now = () => realNow() + clockAdvance;
    const tuning = {
      fsmonitor: false,
      untrackedCache: false,
      maintenance: false,
    };
    if (process.argv.includes("--tune")) {
      try {
        await git(repo, "update-index", "--test-untracked-cache");
        await git(repo, "config", "core.untrackedCache", "true");
        tuning.untrackedCache = true;
      } catch (error) {
        tuning.untrackedCacheError = String(error);
      }
      try {
        await git(repo, "fsmonitor--daemon", "start");
        await git(repo, "config", "core.fsmonitor", "true");
        tuning.fsmonitor = true;
      } catch (error) {
        tuning.fsmonitorError = String(error);
      }
      try {
        await git(
          repo,
          "maintenance",
          "run",
          "--task=commit-graph",
          "--task=incremental-repack",
        );
        tuning.maintenance = true;
      } catch (error) {
        tuning.maintenanceError = String(error);
      }
    }
    const trace = path.join(root, "git-trace.json");
    process.env.GIT_TRACE2_EVENT = trace;
    let active = false,
      stats = 0,
      bytes = 0,
      hits = 0,
      gitOutputBytes = 0,
      indexCopies = 0,
      indexCopyBytes = 0;
    const realStat = fs.stat,
      realLstat = fs.lstat,
      realRead = fs.readFile,
      realStream = nodeFs.createReadStream,
      realCopy = fs.copyFile;
    fs.copyFile = async (...args) => {
      const size = active ? (await realStat(args[0])).size : 0;
      await realCopy(...args);
      if (active) {
        indexCopies++;
        indexCopyBytes += size;
      }
    };
    fs.stat = async (...args) => {
      if (active) stats++;
      return realStat(...args);
    };
    fs.lstat = async (...args) => {
      if (active) stats++;
      return realLstat(...args);
    };
    fs.readFile = async (...args) => {
      const value = await realRead(...args);
      if (active) bytes += Buffer.byteLength(value);
      return value;
    };
    nodeFs.createReadStream = (...args) => {
      const stream = realStream(...args);
      stream.on("data", (chunk) => {
        if (active) bytes += Buffer.byteLength(chunk);
      });
      return stream;
    };
    for (const name of ["spawn", "execFile"]) {
      const original = childProcess[name];
      childProcess[name] = (...args) => {
        const child = original(...args);
        child.stdout?.on("data", (chunk) => {
          if (active) gitOutputBytes += Buffer.byteLength(chunk);
        });
        return child;
      };
    }
    const { ChangeReviewService } = require(
      path.join(dist, "git/change-review.service.js"),
    );
    const fp = require(path.join(dist, "git/git-worktree-fingerprint.js"));
    const system = require(path.join(dist, "config/system-paths.js"));
    await system.buildAugmentedEnvAsync(process.env, repo);
    const service = new ChangeReviewService();
    const { GitService } = require(path.join(dist, "git/git.service.js"));
    const gitService = new GitService(null);
    service.readPullRequestInfo = async () => null;
    for (const name of [
      "getCachedRows",
      "getCachedFileLines",
      "getCachedContextWindow",
      "getCachedFileSummaries",
    ]) {
      const original = service[name].bind(service);
      service[name] = (...args) => {
        const value = original(...args);
        if (value && active) hits++;
        return value;
      };
    }
    const results = [];
    async function measure(name, prepare, operation, rounds = 11) {
      const samples = [];
      for (let i = 0; i < rounds; i++) {
        await prepare(i);
        global.gc?.();
        await fs.writeFile(trace, "");
        stats =
          bytes =
          hits =
          gitOutputBytes =
          indexCopies =
          indexCopyBytes =
            0;
        const queueBefore = service.cacheDiagnostics?.().queue;
        const delay = monitorEventLoopDelay({ resolution: 1 });
        delay.enable();
        let peakHeap = process.memoryUsage().heapUsed,
          peakRss = process.memoryUsage().rss;
        const sampler = setInterval(() => {
          const m = process.memoryUsage();
          peakHeap = Math.max(peakHeap, m.heapUsed);
          peakRss = Math.max(peakRss, m.rss);
        }, 2);
        const start = performance.now();
        active = true;
        let value, error;
        try {
          value = await operation(i);
        } catch (caught) {
          error = String(caught);
        }
        active = false;
        const ms = performance.now() - start;
        clearInterval(sampler);
        delay.disable();
        const events = (await realRead(trace, "utf8"))
          .split("\n")
          .filter(Boolean)
          .map(JSON.parse);
        const counts = {
          git: events.filter((e) => e.event === "start").length,
          stats,
          bytes,
          hits,
          gitOutputBytes,
          indexCopies,
          indexCopyBytes,
        };
        const memory = process.memoryUsage();
        global.gc?.();
        const queueAfter = service.cacheDiagnostics?.().queue;
        samples.push({
          ms,
          ...counts,
          error,
          eventLoopP95Ms: delay.percentile(95) / 1e6,
          heap: memory.heapUsed,
          rss: memory.rss,
          peakHeap: Math.max(peakHeap, memory.heapUsed),
          peakRss: Math.max(peakRss, memory.rss),
          retainedHeapAfterGc: global.gc
            ? process.memoryUsage().heapUsed
            : null,
          retainedCacheBytes: service.cacheDiagnostics?.().bytes ?? null,
          queue: queueAfter ?? null,
          queueMeanDelayMs:
            queueAfter && queueBefore
              ? (queueAfter.totalQueueMs - queueBefore.totalQueueMs) /
                Math.max(1, queueAfter.completed - queueBefore.completed)
              : null,
        });
        assert(value || error);
      }
      const quantile = (key, q) =>
        samples.map((s) => s[key]).sort((a, b) => a - b)[
          Math.min(samples.length - 1, Math.ceil(samples.length * q) - 1)
        ];
      results.push({
        name,
        p50Ms: quantile("ms", 0.5),
        p95Ms: quantile("ms", 0.95),
        gitP50: quantile("git", 0.5),
        statP50: quantile("stats", 0.5),
        bytesP50: quantile("bytes", 0.5),
        hitsP50: quantile("hits", 0.5),
        samples,
      });
      console.log(name, results.at(-1).p50Ms.toFixed(2), "ms");
    }
    await measure(
      "cold-branch-summary",
      async () => {
        service.clearScopeCache(repo, "branch");
        fp.clearWorktreeFingerprintCache(repo);
      },
      () => service.getSummary(repo, "branch"),
    );
    await service.getFileWindow(repo, "branch", "p0/f0.txt");
    await measure(
      "cached-file-window",
      async () => {},
      () => service.getFileWindow(repo, "branch", "p0/f0.txt"),
    );
    await measure(
      "unrelated-edit-window",
      (i) => fs.writeFile(path.join(repo, "p0/f1.txt"), `changed ${i}\n`),
      () => service.getFileWindow(repo, "branch", "p0/f0.txt"),
    );
    await measure(
      "selected-edit-window",
      (i) => fs.writeFile(path.join(repo, "p0/f0.txt"), `changed ${i}\n`),
      () => service.getFileWindow(repo, "branch", "p0/f0.txt"),
    );
    for (let i = 0; i < 300; i++)
      await fs.writeFile(path.join(repo, `new-${i}.txt`), "untracked\n");
    await measure(
      "dirty-untracked-summary",
      () => fp.clearWorktreeFingerprintCache(repo),
      () => service.getSummary(repo, "branch"),
      7,
    );
    await measure(
      "status-poll-unchanged",
      async () => {
        clockAdvance += 5_000;
      },
      () => gitService.getStatusSummary(repo),
      7,
    );
    await measure(
      "status-poll-edit",
      (i) => {
        clockAdvance += 5_000;
        return fs.writeFile(path.join(repo, "p0/f0.txt"), `poll ${i}\n`);
      },
      () => gitService.getStatusSummary(repo),
      7,
    );
    const other = path.join(root, "other");
    await git(repo, "worktree", "add", "-qb", "other", other);
    await fs.writeFile(path.join(other, "p0/f0.txt"), "other\n");
    await measure(
      "multi-worktree-clients-32",
      async (i) => {
        await fs.writeFile(path.join(repo, "p0/f0.txt"), `client ${i}\n`);
      },
      () =>
        Promise.all(
          Array.from({ length: 32 }, (_, i) =>
            service.getFileWindow(i % 2 ? repo : other, "branch", "p0/f0.txt"),
          ),
        ),
      7,
    );
    await measure(
      "fetched-ref-update",
      async (i) => {
        await git(
          repo,
          "update-ref",
          "refs/remotes/origin/main",
          `main~${i % 2}`,
        );
      },
      () => service.getSummary(repo, "branch"),
      7,
    );
    await measure(
      "deep-history-merge-base",
      async () => {
        await git(repo, "update-ref", "refs/remotes/origin/main", "main~1499");
        service.clearScopeCache(repo, "branch");
      },
      () => service.getSummary(repo, "branch"),
      7,
    );
    await git(repo, "update-ref", "refs/remotes/origin/main", "main");
    await git(repo, "reset", "--hard", "HEAD");
    await git(repo, "clean", "-fdq");
    for (let i = 0; i < 200; i++)
      await fs.rename(
        path.join(repo, `p${Math.floor(i / 30)}/f${i % 30}.txt`),
        path.join(repo, `rename-${i}.txt`),
      );
    await git(repo, "add", "-A");
    fp.clearWorktreeFingerprintCache(repo);
    await measure(
      "rename-heavy-summary",
      () => {
        service.clearScopeCache(repo, "branch");
      },
      () => service.getSummary(repo, "branch"),
      7,
    );
    await fs.writeFile(
      path.join(repo, "historical.txt"),
      "large\n".repeat(250000),
    );
    await git(repo, "add", "historical.txt");
    await git(repo, "commit", "-qm", "large history");
    await fs.writeFile(path.join(repo, "historical.txt"), "small\n");
    await measure(
      "large-historical-window",
      () => {
        service.clearScopeCache(repo, "uncommitted");
        fp.clearWorktreeFingerprintCache(repo);
      },
      () => service.getFileWindow(repo, "uncommitted", "historical.txt"),
      5,
    );
    await fs.writeFile(
      path.join(repo, "historical.txt"),
      "large new\n".repeat(150000),
    );
    await measure(
      "large-current-forced-window",
      () => {
        service.clearScopeCache(repo, "uncommitted");
        fp.clearWorktreeFingerprintCache(repo);
      },
      () =>
        service.getFileWindow(repo, "uncommitted", "historical.txt", {
          forceFileLoad: true,
        }),
      5,
    );
    const pressurePaths = Array.from(
      { length: 16 },
      (_, i) => `pressure-${i}.txt`,
    );
    for (const [i, name] of pressurePaths.entries())
      await fs.writeFile(
        path.join(i % 2 ? repo : other, name),
        "pressure\n".repeat(30_000),
      );
    fp.clearWorktreeFingerprintCache(repo);
    fp.clearWorktreeFingerprintCache(other);
    await measure(
      "cache-pressure-16-files-32-clients",
      async (i) => {
        await fs.writeFile(
          path.join(repo, pressurePaths[1]),
          `revision ${i}\n` + "pressure\n".repeat(30_000),
        );
      },
      () =>
        Promise.all(
          Array.from({ length: 32 }, (_, i) =>
            service.getFileWindow(
              i % 2 ? repo : other,
              "uncommitted",
              pressurePaths[i % 16],
              { forceFileLoad: true },
            ),
          ),
        ),
      7,
    );
    await git(
      repo,
      "restore",
      "--source=HEAD",
      "--worktree",
      "--",
      "historical.txt",
    );
    await git(repo, "rm", "--", "historical.txt");
    await fs.writeFile(
      path.join(repo, "historical.txt"),
      "large\n".repeat(250000),
    );
    await measure(
      "restored-untracked-net-comparison",
      async () => {
        service.clearScopeCache(repo, "uncommitted");
        fp.clearWorktreeFingerprintCache(repo);
      },
      async () => {
        const value = await service.getSummary(repo, "uncommitted");
        assert(
          !value.files.some((file) => file.path === "historical.txt"),
          "Restored tracked content must cancel the pending deletion",
        );
        return value;
      },
      5,
    );
    const moduleHashes = {};
    for (const name of [
      "git/change-review.service.js",
      "git/git-worktree-fingerprint.js",
      "git/git.service.js",
      "git/git-local-state.js",
      "git/git-cache.js",
      "git/git-read-scheduler.js",
      "git/git-diff-records.js",
      "git/git-file-stats.js",
      "git/git-review-index.js",
      "git/git-worktree-cache-lifecycle.js",
      "config/system-paths.js",
    ]) {
      moduleHashes[name] = await realRead(path.join(dist, name))
        .then((value) => createHash("sha256").update(value).digest("hex"))
        .catch(() => null);
    }
    const report = {
      sourceCommit: await git(process.cwd(), "rev-parse", "HEAD"),
      node: process.version,
      git: await git(repo, "--version"),
      platform: `${process.platform}/${process.arch}`,
      cpu: os.cpus()[0]?.model,
      benchmarkSha256: createHash("sha256")
        .update(await realRead(__filename))
        .digest("hex"),
      moduleHashes,
      gcExposed: Boolean(global.gc),
      simpleGit: require(
        path.join(
          process.cwd(),
          "apps/backend/node_modules/simple-git/package.json",
        ),
      ).version,
      typescript: require(
        path.join(
          process.cwd(),
          "apps/backend/node_modules/typescript/package.json",
        ),
      ).version,
      fixture: {
        tracked: 6001,
        dirty: 600,
        untracked: 300,
        commits: 1501,
        branches: 502,
        worktrees: 2,
      },
      config: {
        optionalLocks: 0,
        userConfig: false,
        network: false,
        autoMaintenance: false,
        ...tuning,
      },
      results,
    };
    await fs.mkdir(path.dirname(path.resolve(outputArg)), { recursive: true });
    await fs.writeFile(outputArg, JSON.stringify(report, null, 2) + "\n");
  } finally {
    if (process.argv.includes("--tune"))
      await git(path.join(root, "repo"), "fsmonitor--daemon", "stop").catch(
        () => {},
      );
    await fs.rm(root, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
