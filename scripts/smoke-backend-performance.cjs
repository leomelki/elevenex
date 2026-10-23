#!/usr/bin/env node
// Exercise the real HTTP backend against an isolated database, profile and repo.
const assert = require("node:assert/strict");
const { spawn, execFile } = require("node:child_process");
const fs = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");
const exec = promisify(execFile);

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

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) =>
    server.once("error", reject).listen(0, "127.0.0.1", resolve),
  );
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function smoke(entry, output) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "elevenex-backend-smoke-"),
  );
  const repo = path.join(root, "repo");
  const profile = path.join(root, "profile");
  await fs.mkdir(repo);
  await fs.mkdir(profile);
  const git = (...args) => exec("git", args, { cwd: repo });
  await git("init", "-q", "-b", "master");
  await git("config", "user.name", "Smoke fixture");
  await git("config", "user.email", "fixture@example.invalid");
  await fs.writeFile(path.join(repo, "file.txt"), "initial\n");
  await git("add", ".");
  await git("commit", "-qm", "Initial");
  await fs.appendFile(path.join(repo, "file.txt"), "changed\n");
  // Isolate homedir consumers without changing HOME or the user's app config.
  const preload = path.join(root, "profile.cjs");
  await fs.writeFile(
    preload,
    `require('node:os').homedir = () => ${JSON.stringify(profile)};\n`,
  );
  const port = await freePort();
  const dbPath = path.join(root, "smoke.db");
  const child = spawn(process.execPath, ["--require", preload, entry], {
    cwd: path.resolve("apps/backend"),
    env: {
      ...process.env,
      DB_PATH: dbPath,
      ELEVENEX_PROXY_PORT: String(port),
      ELEVENEX_BIND_HOST: "127.0.0.1",
      ELEVENEX_BACKEND_MODE: "local",
      ELEVENEX_BACKEND_RUNTIME_ROOT: process.cwd(),
      SHELL: "/bin/sh",
    },
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (data) => {
    log += data;
  });
  child.stderr.on("data", (data) => {
    log += data;
  });
  const exited = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  const checks = [];
  async function request(route, options = {}, status) {
    const response = await fetch(`http://127.0.0.1:${port}/api/${route}`, {
      ...options,
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(15000),
    });
    const body = await response.text();
    if (status) assert.equal(response.status, status, body);
    else assert(response.ok, `${route}: ${response.status} ${body}`);
    return body ? JSON.parse(body) : null;
  }
  const post = (route, body) =>
    request(route, { method: "POST", body: JSON.stringify(body) });
  try {
    const deadline = Date.now() + 30000;
    for (;;) {
      if (child.exitCode !== null)
        throw new Error(`Backend exited: ${child.exitCode}\n${log}`);
      try {
        await request("projects");
        break;
      } catch (error) {
        if (Date.now() > deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    checks.push("real backend startup and GET projects");
    const project = await post("projects", { name: "Performance smoke" });
    const added = await post(`projects/${project.id}/repos`, { path: repo });
    const repoId = added.id;
    assert.equal(typeof repoId, "number");
    const workspaces = await Promise.all(
      Array.from({ length: 16 }, () => request(`repos/${repoId}/workspaces`)),
    );
    for (const list of workspaces) {
      assert.equal(list.filter((item) => item.isDefault).length, 1);
      assert.equal(list.find((item) => item.isDefault).isDirty, true);
      assert.equal(list.find((item) => item.isDefault).statusError, null);
    }
    checks.push(
      "16 concurrent workspace reads: one default, truthful dirty status",
    );
    const query = `worktreePath=${encodeURIComponent(repo)}`;
    const summaries = await Promise.all(
      Array.from({ length: 32 }, () => request(`git/summary?${query}`)),
    );
    for (const summary of summaries) {
      assert.deepEqual(summary, summaries[0]);
      assert.equal(summary.unstaged.files, 1);
    }
    checks.push("32 concurrent Git summaries have identical output");
    const reviewBefore = await request(
      `git/change-review/summary?${query}&scope=uncommitted`,
    );
    await post("git/stage", { worktreePath: repo, files: ["file.txt"] });
    const staged = await request(`git/summary?${query}`);
    assert.equal(staged.staged.files, 1);
    assert.equal(staged.unstaged.files, 0);
    const committed = await post("git/commit", {
      worktreePath: repo,
      message: "test(smoke): save fixture",
      provider: "codex",
    });
    assert.match(committed.hash, /^[a-f0-9]{40,64}$/);
    const clean = await request(`git/summary?${query}`);
    assert.equal(clean.hasChanges, false);
    assert.notEqual(clean.headSha, staged.headSha);
    const reviewAfter = await request(
      `git/change-review/summary?${query}&scope=uncommitted`,
    );
    assert.notEqual(reviewBefore.headSha, reviewAfter.headSha);
    assert.equal(reviewAfter.files.length, 0);
    checks.push(
      "HTTP stage/commit invalidates status and change-review caches",
    );
    const branchContext = await request(`github/branch-context?${query}`);
    assert.equal(branchContext.branch, "master");
    assert.equal(branchContext.linkedPullRequest, null);
    assert.equal(await request(`github/pull-request?${query}`), null);
    checks.push(
      "GitHub routes return empty state for a repository without remotes",
    );
    const second = await post("projects", { name: "Second project" });
    const todo = await post(`projects/${project.id}/todos`, { text: "owned" });
    const foreign = await post(`projects/${second.id}/todos`, {
      text: "foreign",
    });
    await request(
      `projects/${project.id}/todos/orders`,
      {
        method: "PUT",
        body: JSON.stringify({
          orders: [
            { id: todo.id, sortOrder: 10 },
            { id: foreign.id, sortOrder: 20 },
          ],
        }),
      },
      404,
    );
    assert.equal(
      (await request(`projects/${project.id}/todos`))[0].sortOrder,
      todo.sortOrder,
    );
    assert.equal(
      (await request(`projects/${second.id}/todos`))[0].sortOrder,
      foreign.sortOrder,
    );
    checks.push("cross-project reorder rejected without partial writes");
    const backendRequire = require("node:module").createRequire(
      path.resolve("apps/backend/package.json"),
    );
    const Database = backendRequire("better-sqlite3");
    const db = new Database(dbPath, { readonly: true });
    try {
      assert.deepEqual(db.pragma("foreign_key_check"), []);
      assert.equal(db.pragma("integrity_check", { simple: true }), "ok");
      assert(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE name = 'workspaces_repo_default_unique'",
          )
          .get(),
      );
      checks.push(
        "startup migration applied; SQLite integrity and foreign keys valid",
      );
    } finally {
      db.close();
    }
    await fs.writeFile(
      `${output}.json`,
      JSON.stringify({ entry, checks, passed: true }, null, 2) + "\n",
    );
    console.log(
      `${path.basename(entry)}: ${checks.length} smoke checks passed`,
    );
  } finally {
    if (process.platform === "win32") {
      if (child.exitCode === null) child.kill("SIGKILL");
    } else {
      // Also collect helpers when bootstrap exits before its parent is stopped.
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }
    await exited;
    await fs.writeFile(`${output}.log`, log);
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function main() {
  const output = path.resolve(
    process.argv[2] || "artifacts/backend-performance-review",
  );
  await fs.mkdir(output, { recursive: true });
  for (const [name, entry] of [
    ["production", "apps/backend/dist/main.js"],
    ["bundle", "apps/backend/bundle/main.cjs"],
  ]) {
    await smoke(path.resolve(entry), path.join(output, `http-smoke-${name}`));
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
