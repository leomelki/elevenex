// Run the Git regression slice against one actual executable. Login-shell
// captures must not silently replace it with another Git installed on the host.
import { spawn, execFile } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const root = fileURLToPath(new URL("..", import.meta.url));
const binaryArg = process.argv[2];
if (process.platform === "win32" || !binaryArg || binaryArg.startsWith("--")) {
  throw new Error(
    "Usage on POSIX: node scripts/test-git-runtime.mjs /absolute/path/to/git [--modern]",
  );
}
const binary = await realpath(resolve(binaryArg));
const directory = await mkdtemp(join(tmpdir(), "elevenex-git-runtime-"));
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
try {
  const bin = join(directory, "bin");
  await mkdir(bin);
  for (const name of [
    "git",
    "git-upload-pack",
    "git-receive-pack",
    "git-upload-archive",
  ]) {
    await symlink(binary, join(bin, name));
  }
  const searchPath = `${bin}${delimiter}${process.env.PATH ?? ""}`;
  const shell = join(directory, "shell");
  await writeFile(
    shell,
    `#!/bin/sh\nexport PATH=${quote(searchPath)}\nwhile [ "$#" -gt 0 ] && [ "$1" != '-c' ]; do shift; done\nexec /bin/sh "$@"\n`,
    { mode: 0o700 },
  );
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (
      /^GIT_(DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG.*)$/.test(
        key,
      )
    )
      delete env[key];
  }
  Object.assign(env, {
    PATH: searchPath,
    SHELL: shell,
    GIT_EXEC_PATH: bin,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    ELEVENEX_TEST_MODERN_GIT: process.argv.includes("--modern") ? "1" : "0",
  });
  const { stdout } = await promisify(execFile)(binary, ["--version"], { env });
  process.stdout.write(`Testing ${stdout.trim()} (${binary})\n`);
  const backend = join(root, "apps", "backend");
  const child = spawn(
    process.execPath,
    [
      join(backend, "node_modules", "jest", "bin", "jest.js"),
      "--runInBand",
      "--cacheDirectory",
      join(directory, "jest-cache"),
      "config/git-capabilities.spec.ts",
      "tasks/task-git.service.spec.ts",
      "tasks/tasks.service.spec.ts",
      "git/git-local-state.spec.ts",
      "git/git-reftable-state.spec.ts",
      "worktrees/worktrees.service.spec.ts",
      "desktop-workspace/desktop-project-repositories.spec.ts",
    ],
    { cwd: backend, env, stdio: "inherit" },
  );
  const interrupt = () => child.kill("SIGTERM");
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    process.exitCode = await new Promise((resolveCode, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolveCode(code ?? 1));
    });
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
