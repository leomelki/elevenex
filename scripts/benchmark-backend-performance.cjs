#!/usr/bin/env node
// Compare compiled revisions without contacting GitHub or modifying a user repo.
// Usage: node scripts/benchmark-backend-performance.cjs BASELINE_DIST CURRENT_DIST OUTPUT_DIR
const assert = require("node:assert/strict");
const { execFile, spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");
const { createHash } = require("node:crypto");
const exec = promisify(execFile);
const { performance } = require("node:perf_hooks");

// Never let inherited Git plumbing variables redirect disposable fixture writes.
for (const key of Object.keys(process.env)) {
  if (
    /^GIT_(DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG.*)$/.test(
      key,
    )
  )
    delete process.env[key];
}
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_CONFIG_GLOBAL =
  process.platform === "win32" ? "NUL" : "/dev/null";

async function git(cwd, ...args) {
  return (
    await exec("git", args, { cwd, maxBuffer: 8 * 1024 * 1024 })
  ).stdout.trim();
}

async function fixture(root) {
  const repo = path.join(root, "repo");
  await fs.mkdir(repo, { recursive: true });
  await git(repo, "init", "-q", "-b", "master");
  await git(repo, "config", "user.name", "Performance fixture");
  await git(repo, "config", "user.email", "fixture@example.invalid");
  await git(repo, "config", "core.hooksPath", path.join(root, "no-hooks"));
  for (let folder = 0; folder < 400; folder++) {
    const dir = path.join(repo, `package-${folder}`);
    await fs.mkdir(dir);
    await Promise.all(
      Array.from({ length: 30 }, (_, file) =>
        fs.writeFile(
          path.join(dir, `file-${file}.txt`),
          "first\nsecond\nthird\n",
        ),
      ),
    );
  }
  await git(repo, "add", ".");
  await git(repo, "commit", "-qm", "Initial 12000 files");
  let input = "";
  for (let index = 1; index <= 600; index++) {
    const body = `revision ${index}\n`;
    input += `commit refs/heads/master\nmark :${index}\ncommitter Performance fixture <fixture@example.invalid> ${1700000000 + index} +0000\ndata 5\nchurn\n`;
    if (index === 1) input += "from refs/heads/master^0\n";
    input += `M 100644 inline churn.txt\ndata ${Buffer.byteLength(body)}\n${body}\n`;
    input += `reset refs/heads/feature-${index}\nfrom :${index}\n\n`;
  }
  await new Promise((resolve, reject) => {
    const child = spawn("git", ["fast-import", "--quiet"], {
      cwd: repo,
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(stderr)),
    );
    child.stdin.end(input);
  });
  await git(repo, "reset", "--hard", "HEAD");
  const head = await git(repo, "rev-parse", "HEAD");
  await git(repo, "update-ref", "refs/remotes/origin/master", head);
  await git(
    repo,
    "remote",
    "add",
    "origin",
    "https://github.com/example/performance-fixture.git",
  );
  await git(repo, "config", "branch.master.remote", "origin");
  await git(repo, "config", "branch.master.merge", "refs/heads/master");
  for (let folder = 0; folder < 80; folder++) {
    await Promise.all(
      Array.from({ length: 30 }, (_, file) =>
        fs.appendFile(
          path.join(repo, `package-${folder}`, `file-${file}.txt`),
          "changed\n",
        ),
      ),
    );
  }
  await git(
    repo,
    "add",
    ...Array.from({ length: 40 }, (_, folder) => `package-${folder}`),
  );
  return repo;
}

async function measure(name, rounds, operation, trace) {
  const samples = [];
  let calls = 0;
  let last;
  let gitProcesses = 0;
  for (let index = 0; index < rounds; index++) {
    await fs.writeFile(trace, "");
    const start = performance.now();
    const result = await operation(index);
    samples.push(performance.now() - start);
    calls += result.calls ?? 0;
    last = result.value;
    const events = (await fs.readFile(trace, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(JSON.parse);
    gitProcesses += events.filter((event) => event.event === "start").length;
  }
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    name,
    rounds,
    medianMs: sorted[Math.floor(sorted.length / 2)],
    maxMs: sorted.at(-1),
    samplesMs: samples,
    gitProcesses,
    simulatedGithubCalls: calls,
    value: last,
  };
}

async function worker(dist, repo, trace, output) {
  process.env.GIT_TRACE2_EVENT = trace;
  process.env.GIT_OPTIONAL_LOCKS = "0";
  // A deterministic shell prevents user rc files/version managers adding noise.
  process.env.SHELL = "/bin/sh";
  const { GitService } = require(path.join(dist, "git/git.service.js"));
  const fingerprints = require(
    path.join(dist, "git/git-worktree-fingerprint.js"),
  );
  const { RepoContextResolverService } = require(
    path.join(dist, "github/repo-context-resolver.service.js"),
  );
  const { GithubService } = require(
    path.join(dist, "github/github.service.js"),
  );
  const { GhCommandError } = require(
    path.join(dist, "github/gh-command-runner.service.js"),
  );
  const systemPaths = require(path.join(dist, "config/system-paths.js"));
  const service = new GitService(null);
  const results = [];
  // Prime login environment and filesystem caches equally before measuring.
  await systemPaths.buildAugmentedEnvAsync(process.env, repo);
  await service.getStatusSummary(repo);
  results.push(
    await measure(
      "status-cold-burst-32",
      7,
      async () => {
        fingerprints.clearWorktreeFingerprintCache(repo);
        const values = await Promise.all(
          Array.from({ length: 32 }, () => service.getStatusSummary(repo)),
        );
        for (const value of values) assert.deepEqual(value, values[0]);
        return { value: values[0] };
      },
      trace,
    ),
  );
  results.push(
    await measure(
      "status-warm-single",
      9,
      async () => ({ value: await service.getStatusSummary(repo) }),
      trace,
    ),
  );
  results.push(
    await measure(
      "conflicts-burst-32",
      7,
      async () => {
        const values = await Promise.all(
          Array.from({ length: 32 }, () =>
            service.getStatusSummary(repo, { conflictsOnly: true }),
          ),
        );
        for (const value of values) assert.deepEqual(value, values[0]);
        return { value: values[0] };
      },
      trace,
    ),
  );
  results.push(
    await measure(
      "github-context-burst-32",
      7,
      async () => {
        const resolver = new RepoContextResolverService();
        const values = await Promise.all(
          Array.from({ length: 32 }, () => resolver.resolve(repo)),
        );
        for (const value of values) assert.deepEqual(value, values[0]);
        // HEAD was added to the resolver response; compare shared public fields.
        const { headSha, ...value } = values[0];
        return { value };
      },
      trace,
    ),
  );
  const runner = (present) => {
    const state = { calls: 0 };
    state.run = async (args) => {
      state.calls++;
      await new Promise((resolve) => setTimeout(resolve, 25));
      if (!present)
        throw new GhCommandError(
          "no pull requests found",
          1,
          "",
          "no pull requests found",
        );
      if (args[1] === "checks") return "[]";
      return JSON.stringify({
        number: 1,
        title: "Fixture",
        url: "https://example.invalid/pr/1",
        state: "OPEN",
        baseRefName: "master",
        headRefName: "master",
      });
    };
    return state;
  };
  results.push(
    await measure(
      "github-missing-pr-burst-32",
      7,
      async () => {
        const commands = runner(false);
        const github = new GithubService(
          commands,
          new RepoContextResolverService(),
          service,
        );
        const values = await Promise.all(
          Array.from({ length: 32 }, () => github.getPullRequest(repo)),
        );
        assert(values.every((value) => value === null));
        return { value: null, calls: commands.calls };
      },
      trace,
    ),
  );
  const commands = runner(true);
  const github = new GithubService(
    commands,
    new RepoContextResolverService(),
    service,
  );
  await github.getPullRequest(repo);
  results.push(
    await measure(
      "github-positive-pr-warm-single",
      9,
      async () => {
        const before = commands.calls;
        return {
          value: await github.getPullRequest(repo),
          calls: commands.calls - before,
        };
      },
      trace,
    ),
  );
  const names = Array.from({ length: 20_000 }, (_, i) => `new-file-${i}`);
  const status = {
    conflicted: [],
    renamed: [],
    staged: names,
    created: names,
    modified: [],
    not_added: [],
    deleted: [],
    files: names.map((file) => ({ path: file, index: "A", working_dir: " " })),
  };
  results.push(
    await measure(
      "map-20000-staged-additions-cpu",
      9,
      async () => ({ value: service.toFileStatuses(status) }),
      trace,
    ),
  );
  // Separate correctness output from the small timing/call-count report.
  const values = Object.fromEntries(
    results.map((result) => [result.name, result.value]),
  );
  await fs.writeFile(`${output}.values.json`, JSON.stringify(values));
  await fs.writeFile(
    output,
    JSON.stringify(
      results.map(({ value, ...result }) => result),
      null,
      2,
    ) + "\n",
  );
}

async function main() {
  if (process.argv[2] === "--worker") {
    await worker(...process.argv.slice(3));
    return;
  }
  const [beforeArg, afterArg, outputArg] = process.argv.slice(2);
  if (!beforeArg || !afterArg || !outputArg)
    throw new Error("Expected BASELINE_DIST CURRENT_DIST OUTPUT_DIR");
  const [before, after, output] = [beforeArg, afterArg, outputArg].map((arg) =>
    path.resolve(arg),
  );
  await fs.mkdir(output, { recursive: true });
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "elevenex-performance-"),
  );
  try {
    const repo = await fixture(root);
    // Alternate order in a second pass to expose cache/order and machine noise.
    for (const [pass, revisions] of [
      [
        1,
        [
          ["before", before],
          ["after", after],
        ],
      ],
      [
        2,
        [
          ["after", after],
          ["before", before],
        ],
      ],
    ]) {
      for (const [name, dist] of revisions) {
        console.log(`Measuring ${name}, pass ${pass}`);
        const result = await exec(
          process.execPath,
          [
            __filename,
            "--worker",
            dist,
            repo,
            path.join(root, "trace.json"),
            path.join(output, `${name}-${pass}.json`),
          ],
          { maxBuffer: 2 * 1024 * 1024 },
        );
        if (result.stderr) process.stderr.write(result.stderr);
      }
      assert.deepEqual(
        JSON.parse(
          await fs.readFile(
            path.join(output, `before-${pass}.json.values.json`),
          ),
        ),
        JSON.parse(
          await fs.readFile(
            path.join(output, `after-${pass}.json.values.json`),
          ),
        ),
      );
    }
    const comparisons = [];
    for (const pass of [1, 2]) {
      const baseline = JSON.parse(
        await fs.readFile(path.join(output, `before-${pass}.json`)),
      );
      const current = JSON.parse(
        await fs.readFile(path.join(output, `after-${pass}.json`)),
      );
      for (const [index, item] of baseline.entries()) {
        const next = current[index];
        comparisons.push({
          pass,
          workload: item.name,
          beforeMedianMs: item.medianMs,
          afterMedianMs: next.medianMs,
          speedup: item.medianMs / next.medianMs,
          beforeGitProcesses: item.gitProcesses,
          afterGitProcesses: next.gitProcesses,
          beforeSimulatedGithubCalls: item.simulatedGithubCalls,
          afterSimulatedGithubCalls: next.simulatedGithubCalls,
        });
      }
    }
    const moduleHashes = {};
    for (const [name, dist] of [
      ["before", before],
      ["after", after],
    ]) {
      moduleHashes[name] = {};
      for (const module of [
        "git/git.service.js",
        "git/git-worktree-fingerprint.js",
        "github/github.service.js",
        "github/repo-context-resolver.service.js",
        "config/system-paths.js",
      ]) {
        moduleHashes[name][module] = createHash("sha256")
          .update(await fs.readFile(path.join(dist, module)))
          .digest("hex");
      }
    }
    const report = {
      sourceCommit: await git(process.cwd(), "rev-parse", "HEAD"),
      baselineCommit: process.env.ELEVENEX_BENCHMARK_BASELINE_REF || null,
      moduleHashes,
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      cpu: os.cpus()[0]?.model,
      gitVersion: (await exec("git", ["--version"])).stdout.trim(),
      fixture: {
        trackedFiles: 12001,
        dirtyFiles: 2400,
        stagedFiles: 1200,
        branches: 601,
        commits: 601,
      },
      simulatedGithubLatencyMs: 25,
      outputsEqual: true,
      comparisons,
    };
    await fs.writeFile(
      path.join(output, "comparison.json"),
      JSON.stringify(report, null, 2) + "\n",
    );
    console.table(comparisons);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
