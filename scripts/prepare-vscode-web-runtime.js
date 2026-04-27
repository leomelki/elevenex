const { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const stageBaseRoot = path.join(repoRoot, 'apps', 'electron', '.stage');
const stagedAssetsRoot = path.join(stageBaseRoot, 'runtime-assets');
const stagedVSCodeRoot = path.join(stagedAssetsRoot, 'vscode-web-dist');
const sourceVSCodeRoot = path.join(repoRoot, 'apps', 'backend', 'node_modules', 'vscode-web', 'dist');
const runtimeConfig = require(path.join(repoRoot, 'config', 'vscode-web-runtime.json'));

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

    if (fullPath.endsWith('.map')) {
      rmSync(fullPath, { force: true });
    }
  }
}

const GIT_ARTIFACT_NAMES = new Set([
  '.git',
  '.github',
  '.gitignore',
  '.gitattributes',
  '.gitmodules',
  '.gitkeep',
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

function assembleRuntime() {
  if (!existsSync(sourceVSCodeRoot)) {
    throw new Error(`VS Code Web package dist is missing at ${sourceVSCodeRoot}`);
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

  const stagedExtensionsRoot = path.join(stagedVSCodeRoot, 'extensions');
  ensureDir(stagedExtensionsRoot);
  for (const extensionName of runtimeConfig.builtinExtensions) {
    copyRequiredPath(
      path.join(sourceVSCodeRoot, 'extensions', extensionName),
      path.join(stagedExtensionsRoot, extensionName),
    );
  }

  writeFileSync(path.join(stagedVSCodeRoot, 'index.html'), buildIndexHtml());

  removeSourceMaps(stagedVSCodeRoot);
  removeGitArtifacts(stagedVSCodeRoot);

  const extensionCount = runtimeConfig.builtinExtensions.length;
  const totalSize = getDirectorySize(stagedVSCodeRoot);
  console.log(
    `Prepared staged VS Code runtime at ${stagedVSCodeRoot} (${extensionCount} built-in extensions, ${formatSize(totalSize)})`,
  );
}

if (require.main === module) {
  try {
    assembleRuntime();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

module.exports = {
  assembleRuntime,
  formatSize,
  getDirectorySize,
  removeGitArtifacts,
  stagedVSCodeRoot,
};
