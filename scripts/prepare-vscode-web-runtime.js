const {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} = require("fs");
const path = require("path");
const { promises: fs } = require("fs");
const { promisify } = require("util");
const zlib = require("zlib");
const brotli = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);

const repoRoot = path.resolve(__dirname, "..");
const stageBaseRoot = path.join(repoRoot, "apps", "electron", ".stage");
const stagedAssetsRoot = path.join(stageBaseRoot, "runtime-assets");
const stagedVSCodeRoot = path.join(stagedAssetsRoot, "vscode-web-dist");
const sourceVSCodeRoot = path.join(
  repoRoot,
  "apps",
  "backend",
  "node_modules",
  "vscode-web",
  "dist",
);
const runtimeConfig = require(
  path.join(repoRoot, "config", "vscode-web-runtime.json"),
);

function ensureDir(dirPath) {
  mkdirSync(dirPath, { recursive: true });
}

function copyRequiredPath(source, destination, options = {}) {
  if (!existsSync(source)) {
    throw new Error(`Required path is missing: ${source}`);
  }

  ensureDir(path.dirname(destination));
  cpSync(source, destination, { recursive: true, ...options });
}

function removeSourceMaps(rootDir) {
  if (!existsSync(rootDir)) {
    return;
  }

  for (const entry of readdirSync(rootDir)) {
    const fullPath = path.join(rootDir, entry);
    const stats = statSync(fullPath);

    if (stats.isDirectory()) {
      removeSourceMaps(fullPath);
      continue;
    }

    if (fullPath.endsWith(".map")) {
      rmSync(fullPath, { force: true });
    }
  }
}

const GIT_ARTIFACT_NAMES = new Set([
  ".git",
  ".github",
  ".gitignore",
  ".gitattributes",
  ".gitmodules",
  ".gitkeep",
]);

function removeGitArtifacts(rootDir) {
  if (!existsSync(rootDir)) {
    return;
  }

  for (const entry of readdirSync(rootDir)) {
    const fullPath = path.join(rootDir, entry);

    if (GIT_ARTIFACT_NAMES.has(entry)) {
      rmSync(fullPath, { recursive: true, force: true });
      continue;
    }

    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      removeGitArtifacts(fullPath);
    }
  }
}

function getDirectorySize(rootDir) {
  if (!existsSync(rootDir)) {
    return 0;
  }

  const stats = statSync(rootDir);
  if (!stats.isDirectory()) {
    return stats.size;
  }

  let total = 0;
  for (const entry of readdirSync(rootDir)) {
    total += getDirectorySize(path.join(rootDir, entry));
  }
  return total;
}

function countChildDirectories(rootDir) {
  if (!existsSync(rootDir)) {
    return 0;
  }

  return readdirSync(rootDir).filter((entry) =>
    statSync(path.join(rootDir, entry)).isDirectory(),
  ).length;
}

function formatSize(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function buildIndexHtml() {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>VS Code Web</title>
  <script>
    window.location.replace('./out/vs/code/browser/workbench/workbench.html' + window.location.search + window.location.hash);
  </script>
</head>
<body>
  <p>Redirecting to VS Code Web...</p>
</body>
</html>
`;
}

async function precompressRuntime(root) {
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await precompressRuntime(file);
      continue;
    }
    if (
      !/\.(?:js|css|json|svg|wasm)$/.test(file) ||
      (await fs.stat(file)).size < 1024
    )
      continue;
    const content = await fs.readFile(file);
    const [br, gz] = await Promise.all([
      brotli(content, {
        params: {
          [zlib.constants.BROTLI_PARAM_QUALITY]:
            runtimeConfig.brotliQuality || 5,
        },
      }),
      gzip(content, { level: 6 }),
    ]);
    if (br.length < content.length) await fs.writeFile(file + ".br", br);
    if (gz.length < content.length) await fs.writeFile(file + ".gz", gz);
  }
}

async function assembleRuntime() {
  if (!existsSync(sourceVSCodeRoot)) {
    throw new Error(
      `VS Code Web package dist is missing at ${sourceVSCodeRoot}`,
    );
  }

  rmSync(stagedVSCodeRoot, { recursive: true, force: true });
  ensureDir(stagedVSCodeRoot);

  for (const relativePath of runtimeConfig.rootFiles) {
    copyRequiredPath(
      path.join(sourceVSCodeRoot, relativePath),
      path.join(stagedVSCodeRoot, relativePath),
    );
  }

  for (const directoryName of runtimeConfig.directories) {
    copyRequiredPath(
      path.join(sourceVSCodeRoot, directoryName),
      path.join(stagedVSCodeRoot, directoryName),
    );
  }

  writeFileSync(path.join(stagedVSCodeRoot, "index.html"), buildIndexHtml());

  removeSourceMaps(stagedVSCodeRoot);
  removeGitArtifacts(stagedVSCodeRoot);

  await precompressRuntime(stagedVSCodeRoot);

  const stagedExtensionsRoot = path.join(stagedVSCodeRoot, "extensions");
  const extensionCount = countChildDirectories(stagedExtensionsRoot);
  const totalSize = getDirectorySize(stagedVSCodeRoot);
  console.log(
    `Prepared staged VS Code runtime at ${stagedVSCodeRoot} (${extensionCount} built-in extensions, ${formatSize(totalSize)})`,
  );
}

if (require.main === module) {
  assembleRuntime().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

module.exports = {
  assembleRuntime,
  precompressRuntime,
  formatSize,
  countChildDirectories,
  getDirectorySize,
  removeGitArtifacts,
  stagedVSCodeRoot,
};
