// Local disposable fixture; never tunes a user's repository or contacts a remote.
// Usage: node scripts/benchmark-task-git.cjs apps/backend/dist artifacts/task-git.json
const assert = require("node:assert/strict");
const { execFile, spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { promisify } = require("node:util");
const exec = promisify(execFile);

async function main() {
  const [distArg, outputArg] = process.argv.slice(2);
  if (!distArg || !outputArg)
    throw new Error("Expected backend DIST and OUTPUT.json");
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
  });
  const root = await fs.mkdtemp(path.join(tmpdir(), "elevenex-task-bench-"));
  const git = async (...args) =>
    (await exec("git", args, { cwd: root })).stdout.trim();
  try {
    await git("init", "--quiet");
    await git("symbolic-ref", "HEAD", "refs/heads/main");
    await git("config", "user.name", "Performance fixture");
    await git("config", "user.email", "fixture@example.invalid");
    await git("config", "commit.gpgsign", "false");
    await git("config", "core.untrackedCache", "true");
    for (let directory = 0; directory < 100; directory++) {
      const folder = path.join(root, `package-${directory}`);
      await fs.mkdir(folder);
      await Promise.all(
        Array.from({ length: 50 }, (_, index) =>
          fs.writeFile(path.join(folder, `file-${index}.txt`), "one\ntwo\n"),
        ),
      );
    }
    await git("add", ".");
    await git("commit", "--quiet", "-m", "Initial 5000 files");
    let input = "";
    for (let index = 1; index <= 600; index++) {
      input += `reset refs/heads/feature-${index}\nfrom refs/heads/main\n\n`;
    }
    for (let index = 1; index <= 400; index++) {
      input += `commit refs/heads/history\ncommitter Fixture <fixture@example.invalid> ${1700000000 + index} +0000\ndata 5\nchurn\n`;
      if (index === 1) input += "from refs/heads/main\n";
      input += "\n";
    }
    await new Promise((resolve, reject) => {
      const child = spawn("git", ["fast-import", "--quiet"], {
        cwd: root,
        stdio: ["pipe", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.once("error", reject);
      child.once("close", (code) =>
        code === 0 ? resolve() : reject(new Error(stderr)),
      );
      child.stdin.end(input);
    });
    await git("remote", "add", "origin", root);
    await git("remote", "add", "upstream", root);
    await git("update-ref", "refs/remotes/origin/trunk", "history");
    await git(
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/trunk",
    );
    const trace = path.join(root, "trace.jsonl");
    process.env.GIT_TRACE2_EVENT = trace;
    // Keep trace output out of untracked status results.
    await fs.mkdir(path.join(root, ".git", "info"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".git", "info", "exclude"),
      "trace.jsonl\n",
    );
    const dist = path.resolve(distArg);
    const { worktreeSimpleGit } = require(
      path.join(dist, "config/system-paths.js"),
    );
    const { TaskGitService } = require(
      path.join(dist, "tasks/task-git.service.js"),
    );
    const service = new TaskGitService();
    const client = worktreeSimpleGit(root);
    const beforeConfig = await git("config", "--null", "--list");
    await service.status(root, { persistIndex: true });
    const previousStatus = async () => {
      const [status, branch, head] = await Promise.all([
        client.raw(["status", "--porcelain=v1", "--untracked-files=normal"]),
        client
          .raw(["symbolic-ref", "--quiet", "--short", "HEAD"])
          .catch(() => ""),
        service.resolve(root, "HEAD"),
      ]);
      return {
        dirty: !!status.trim(),
        conflicts: status
          .split("\n")
          .some((line) => /^(DD|AU|UD|UA|DU|AA|UU)/.test(line)),
        branch: branch.trim() || null,
        head,
      };
    };
    const previousBase = async () => {
      const remotes = (await client.getRemotes()).sort((a, b) =>
        a.name === "origin"
          ? -1
          : b.name === "origin"
            ? 1
            : a.name.localeCompare(b.name),
      );
      for (const { name } of remotes) {
        try {
          const ref = (
            await client.raw([
              "symbolic-ref",
              "-q",
              `refs/remotes/${name}/HEAD`,
            ])
          ).trim();
          await service.resolve(root, ref);
          return ref;
        } catch {
          /* Try conventional candidates. */
        }
        for (const branch of ["main", "master"]) {
          const ref = `refs/remotes/${name}/${branch}`;
          try {
            await service.resolve(root, ref);
            return ref;
          } catch {
            /* Next candidate. */
          }
        }
      }
      for (const branch of ["main", "master"]) {
        if (await service.hasLocalBranch(root, branch))
          return `refs/heads/${branch}`;
      }
      return null;
    };
    const results = {};
    const measurePair = async (name, previous, current) => {
      assert.deepEqual(await current(), await previous());
      const samples = { previous: [], current: [] };
      const processes = { previous: 0, current: 0 };
      for (let round = 0; round < 10; round++) {
        const order =
          round % 2
            ? [
                ["current", current],
                ["previous", previous],
              ]
            : [
                ["previous", previous],
                ["current", current],
              ];
        for (const [label, operation] of order) {
          await fs.writeFile(trace, "");
          const start = performance.now();
          await operation();
          samples[label].push(performance.now() - start);
          processes[label] += (await fs.readFile(trace, "utf8"))
            .split("\n")
            .filter(Boolean)
            .map(JSON.parse)
            .filter((event) => event.event === "start").length;
        }
      }
      results[name] = Object.fromEntries(
        Object.keys(samples).map((label) => [
          label,
          {
            medianMs: [...samples[label]].sort((a, b) => a - b)[5],
            processesPerCall: processes[label] / samples[label].length,
          },
        ]),
      );
    };
    await measurePair("status", previousStatus, () => service.status(root));
    await measurePair("defaultBranchWithRemoteHead", previousBase, () =>
      service.defaultBase(root),
    );
    await git("symbolic-ref", "--delete", "refs/remotes/origin/HEAD");
    await measurePair("defaultBranchWithoutRemoteDefaults", previousBase, () =>
      service.defaultBase(root),
    );
    for (let directory = 0; directory < 100; directory++) {
      await Promise.all(
        Array.from({ length: 50 }, (_, index) =>
          fs.appendFile(
            path.join(root, `package-${directory}`, `file-${index}.txt`),
            "changed\n",
          ),
        ),
      );
    }
    await git(
      "add",
      ...Array.from({ length: 50 }, (_, index) => `package-${index}`),
    );
    await measurePair("statusWith5000ChangedFiles", previousStatus, () =>
      service.status(root),
    );
    assert.equal(await git("config", "--null", "--list"), beforeConfig);
    const report = {
      gitVersion: await git("--version"),
      files: 5000,
      branches: 602,
      commits: 401,
      rounds: 10,
      results,
    };
    const output = path.resolve(outputArg);
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, JSON.stringify(report, null, 2) + "\n");
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } finally {
    delete process.env.GIT_TRACE2_EVENT;
    await fs.rm(root, { recursive: true, force: true });
  }
}
main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
});
