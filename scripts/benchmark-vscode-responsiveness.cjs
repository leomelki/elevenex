#!/usr/bin/env node
// Isolated HTTP/service load test. Client runs in a separate process from the
// measured event loop. Usage: node scripts/benchmark-vscode-responsiveness.cjs BASE_DIST NEW_DIST OUTPUT.json
const { fork, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { performance, monitorEventLoopDelay } = require("node:perf_hooks");
const { setTimeout: sleep } = require("node:timers/promises");
const exec = promisify(execFile);
const percentile = (values, p) =>
  [...values].sort((a, b) => a - b)[
    Math.min(values.length - 1, Math.floor(values.length * p))
  ] || 0;
const summary = (values) => ({
  n: values.length,
  medianMs: percentile(values, 0.5),
  p95Ms: percentile(values, 0.95),
  p99Ms: percentile(values, 0.99),
  maxMs: Math.max(0, ...values),
});

async function serve(dist, root) {
  const { FilesService, prepareSearchCandidates } = require(
    path.join(dist, "files/files.service.js"),
  );
  const { FileWatcherService } = require(
    path.join(dist, "file-watcher/file-watcher.service.js"),
  );
  const { FileChangeGateway } = require(
    path.join(dist, "file-watcher/file-change.gateway.js"),
  );
  const service = new FilesService();
  const watcher = new FileWatcherService();
  const gateway = new FileChangeGateway(watcher, service);
  const http = require("node:http");
  let paths = [],
    index,
    indexLoad;
  const realLoader = service.listSearchCandidatePaths.bind(service);
  let synthesized = true;
  service.listSearchCandidatePaths = async (tree) => {
    if (!synthesized) return realLoader(tree);
    if (!prepareSearchCandidates) return paths;
    return (
      index ||
      (indexLoad ||= prepareSearchCandidates(paths).then(
        (value) => (index = value),
      ))
    );
  };
  const delay = monitorEventLoopDelay({ resolution: 1 });
  delay.enable();
  let peaks = {};
  const sample = () => {
    for (const name of ["searchQueue", "refreshQueue", "ioQueue"]) {
      peaks[`${name}Active`] = Math.max(
        peaks[`${name}Active`] || 0,
        service[name]?.active || 0,
      );
      peaks[`${name}Pending`] = Math.max(
        peaks[`${name}Pending`] || 0,
        service[name]?.pending.length || 0,
      );
    }
  };
  const sampler = setInterval(sample, 2);
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    try {
      let result;
      if (url.pathname === "/probe") result = { ok: true };
      else if (url.pathname === "/configure") {
        paths = Array.from(
          { length: Number(url.searchParams.get("n")) },
          (_, i) =>
            `packages/${i % 700}/src/test-file-${(i * 7919) % 100000}.ts`,
        );
        index = indexLoad = undefined;
        synthesized = true;
        if (service.invalidateEditorWorkspace)
          service.invalidateEditorWorkspace(root);
        result = { ok: true };
      } else if (url.pathname === "/real") {
        synthesized = false;
        result = { ok: true };
      } else if (url.pathname === "/reset") {
        delay.reset();
        peaks = {};
        global.gc?.();
        result = { rss: process.memoryUsage().rss };
      } else if (url.pathname === "/stats")
        result = {
          eventLoopP95Ms: delay.percentile(95) / 1e6,
          eventLoopP99Ms: delay.percentile(99) / 1e6,
          eventLoopMaxMs: delay.max / 1e6,
          rss: process.memoryUsage().rss,
          peaks,
          watchers: watcher.getActiveWatcherCount(),
          gatewayWorktrees: gateway.clients.size,
          pendingBatches: gateway.pending?.size || 0,
          remainingSearches: service.searches?.size || 0,
          activeHandles: process._getActiveHandles().reduce((out, handle) => {
            const name = handle.constructor.name;
            out[name] = (out[name] || 0) + 1;
            return out;
          }, {}),
        };
      else if (url.pathname === "/search") {
        const controller = new AbortController();
        res.once("close", () => controller.abort());
        result = await service.searchFiles(
          root,
          url.searchParams.get("q") || "",
          100,
          controller.signal,
        );
      } else if (url.pathname === "/list")
        result = await service.listFiles(
          root,
          url.searchParams.get("dir") || "",
        );
      else if (url.pathname === "/burst") {
        for (let start = 0; start < 5000; start += 16)
          await Promise.all(
            Array.from({ length: 16 }, (_, offset) => {
              const i = start + offset;
              return fs.writeFile(
                path.join(root, `directory-${i % 100}`, `edit-${i}.ts`),
                `edit ${i}\n`,
              );
            }),
          );
        // Head and refs change frequently without touching source paths.
        for (let i = 0; i < 10; i++)
          await exec("git", ["commit", "--allow-empty", "-qm", `burst-${i}`], {
            cwd: root,
          });
        result = { changed: 5000 };
      } else {
        res.statusCode = 404;
        result = {};
      }
      if (!res.destroyed) res.end(JSON.stringify(result));
    } catch (error) {
      if (!res.destroyed) {
        res.statusCode = error.getStatus?.() || 500;
        res.end(JSON.stringify({ error: error.message }));
      }
    }
  });
  gateway.attachToServer(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.send({ port: server.address().port });
  process.on("message", async (message) => {
    if (message === "stop") {
      clearInterval(sampler);
      gateway.onModuleDestroy();
      await watcher.onModuleDestroy();
      server.closeAllConnections();
      server.close(() => process.exit(0));
    }
  });
}

async function fixture() {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "elevenex-vscode-load-"),
  );
  for (let i = 0; i < 100; i++) {
    const directory = path.join(root, `directory-${i}`);
    await fs.mkdir(directory);
    await Promise.all(
      Array.from({ length: 100 }, (_, j) =>
        fs.writeFile(
          path.join(directory, `file-${j}.ts`),
          `export const value = ${j};\n`,
        ),
      ),
    );
  }
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["config", "user.name", "Benchmark"],
    ["config", "user.email", "benchmark@example.invalid"],
    ["config", "core.hooksPath", path.join(root, "no-hooks")],
    ["add", "."],
    ["commit", "-qm", "fixture"],
  ])
    await exec("git", args, { cwd: root });
  const sha = (
    await exec("git", ["rev-parse", "HEAD"], { cwd: root })
  ).stdout.trim();
  await new Promise((resolve, reject) => {
    const child = require("node:child_process").spawn(
      "git",
      ["update-ref", "--stdin"],
      { cwd: root },
    );
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error("update-ref failed")),
    );
    child.stdin.end(
      Array.from(
        { length: 400 },
        (_, i) => `update refs/heads/branch-${i} ${sha}\n`,
      ).join(""),
    );
  });
  return root;
}

async function benchmark(dist, root) {
  const child = fork(__filename, ["--serve", path.resolve(dist), root], {
    execArgv: ["--expose-gc"],
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  const port = await new Promise((resolve, reject) => {
    child.once("message", (message) => resolve(message.port));
    child.once("exit", (code) => reject(new Error(`Server exited ${code}`)));
  });
  const base = `http://127.0.0.1:${port}`;
  const request = async (route, signal) => {
    const response = await fetch(base + route, {
      signal: signal || AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  };
  async function measured(work) {
    const before = await request("/reset");
    let pending = 0,
      timeouts = 0;
    const probes = [];
    const timer = setInterval(() => {
      if (pending >= 4) return;
      pending++;
      const start = performance.now();
      void request("/probe", AbortSignal.timeout(1000))
        .then(() => probes.push(performance.now() - start))
        .catch(() => timeouts++)
        .finally(() => pending--);
    }, 5);
    let value;
    try {
      value = await work();
      await sleep(25);
    } finally {
      clearInterval(timer);
      while (pending) await sleep(2);
    }
    return {
      ...value,
      probe: { ...summary(probes), timeouts },
      server: await request("/stats"),
      beforeRss: before.rss,
    };
  }
  const results = {};
  try {
    for (const n of [10000, 50000, 100000]) {
      await request(`/configure?n=${n}`);
      const cold = await measured(async () => {
        const start = performance.now();
        await request("/search?q=file");
        return { elapsedMs: performance.now() - start };
      });
      const warm = await measured(async () => {
        const timings = [];
        for (let i = 0; i < 30; i++) {
          const start = performance.now();
          await request(`/search?q=${i % 3 ? "file" : "packages"}`);
          timings.push(performance.now() - start);
        }
        return { queries: summary(timings) };
      });
      const typing = await measured(async () => {
        let aborted = 0,
          errors = 0;
        await Promise.all(
          Array.from({ length: 6 }, async (_, editor) => {
            let previous;
            const work = [];
            for (let i = 0; i < 30; i++) {
              previous?.abort();
              const controller = new AbortController();
              previous = controller;
              work.push(
                request(
                  `/search?q=${"zzzzz".slice(0, (i % 5) + 1)}${editor}`,
                  controller.signal,
                ).catch((error) => {
                  if (controller.signal.aborted) aborted++;
                  else errors++;
                }),
              );
              await sleep(10);
            }
            await Promise.all(work);
          }),
        );
        return { requested: 180, aborted, errors };
      });
      results[n] = { cold, warm, typing };
    }
    await request("/real");
    results.realCold = await measured(async () => {
      const start = performance.now();
      await request("/search?q=file");
      return { elapsedMs: performance.now() - start };
    });
    results.directories = await measured(async () => {
      await Promise.all(
        Array.from({ length: 200 }, (_, i) =>
          request(`/list?dir=directory-${i % 100}`),
        ),
      );
      return { requests: 200 };
    });
    const WebSocket = require("../apps/backend/node_modules/ws");
    let frames = 0,
      notifications = 0;
    const sockets = await Promise.all(
      Array.from(
        { length: 6 },
        () =>
          new Promise((resolve, reject) => {
            const socket = new WebSocket(
              `ws://127.0.0.1:${port}/file-changes?worktreePath=${encodeURIComponent(root)}`,
            );
            socket.once("error", reject);
            socket.once("open", () => resolve(socket));
            socket.on("message", (data) => {
              frames++;
              const payload = JSON.parse(String(data));
              notifications += Array.isArray(payload) ? payload.length : 1;
            });
          }),
      ),
    );
    results.edits = await measured(async () => {
      await request("/burst");
      await sleep(3000);
      return { editors: 6, changedPaths: 5000, frames, notifications };
    });
    for (const socket of sockets) socket.close();
    await sleep(100);
    results.afterDisconnect = await request("/stats");
    return results;
  } finally {
    child.send("stop");
    await new Promise((resolve) => child.once("exit", resolve));
  }
}

if (process.argv[2] === "--serve")
  serve(process.argv[3], process.argv[4]).catch((error) => {
    console.error(error);
    process.exit(1);
  });
else
  (async () => {
    const [baseline, current, output] = process.argv.slice(2);
    if (!output)
      throw new Error("Usage: BASELINE_DIST CURRENT_DIST OUTPUT.json");
    const root = await fixture();
    try {
      const baselineResult = await benchmark(baseline, root);
      await exec("git", ["reset", "--hard", "refs/heads/branch-0"], {
        cwd: root,
      });
      await exec("git", ["clean", "-fd"], { cwd: root });
      const result = {
        node: process.version,
        platform: `${process.platform}-${process.arch}`,
        fixture: { files: 10000, directories: 100, branches: 401 },
        budgets: {
          probeP99Ms: 50,
          eventLoopP99Ms: 20,
          eventLoopMaxMs: 100,
          probeTimeouts: 0,
        },
        baseline: baselineResult,
        current: await benchmark(current, root),
      };
      await fs.mkdir(path.dirname(output), { recursive: true });
      await fs.writeFile(output, JSON.stringify(result, null, 2) + "\n");
      for (const revision of ["baseline", "current"])
        for (const n of [10000, 50000, 100000]) {
          const phase = result[revision][n];
          console.log(
            JSON.stringify({
              revision,
              n,
              coldMs: phase.cold.elapsedMs,
              warmMedianMs: phase.warm.queries.medianMs,
              warmProbeP99Ms: phase.warm.probe.p99Ms,
              warmLoopMaxMs: phase.warm.server.eventLoopMaxMs,
              typingProbeP99Ms: phase.typing.probe.p99Ms,
            }),
          );
        }
      console.log(`Results: ${output}`);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
