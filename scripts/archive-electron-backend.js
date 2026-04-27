const { existsSync, readdirSync, rmSync, statSync } = require('fs');
const { execFileSync } = require('child_process');
const path = require('path');
const { formatSize, getDirectorySize } = require('./prepare-vscode-web-runtime');

const repoRoot = path.resolve(__dirname, '..');
const stageBaseRoot = path.join(repoRoot, 'apps', 'electron', '.stage');
const stageBackendRoot = path.join(stageBaseRoot, 'backend');
const archivePath = path.join(stageBaseRoot, 'backend.tar.gz');
const STAGED_NODE_MODULES_ROOT = path.join(stageBackendRoot, 'node_modules');
const STAGED_BACKEND_WARN_THRESHOLD_BYTES = 110 * 1024 * 1024;
const REQUIRED_NATIVE_RUNTIME_ARTIFACTS = [
  path.join(STAGED_NODE_MODULES_ROOT, 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'),
  path.join(STAGED_NODE_MODULES_ROOT, 'node-pty', 'build', 'Release', 'pty.node'),
];
const FINAL_RUNTIME_PACKAGE_PLANS = {
  'better-sqlite3': {
    files: ['package.json', 'LICENSE'],
    directories: ['lib'],
    optionalDirectories: ['build/Release'],
  },
  'node-pty': {
    files: ['package.json', 'LICENSE'],
    directories: ['lib'],
    optionalDirectories: ['build/Release', `prebuilds/${process.platform}-${process.arch}`],
  },
  bindings: {
    files: ['package.json', 'bindings.js', 'LICENSE.md'],
    optionalFiles: ['README.md'],
    optionalDirectories: [],
  },
  'file-uri-to-path': {
    files: ['package.json', 'index.js', 'LICENSE'],
  },
};

function keepOnly(packageRoot, plan) {
  if (!existsSync(packageRoot)) {
    return;
  }

  const keep = new Set();
  for (const relativePath of plan.files || []) {
    keep.add(relativePath);
  }
  for (const relativePath of plan.optionalFiles || []) {
    if (existsSync(path.join(packageRoot, relativePath))) {
      keep.add(relativePath);
    }
  }
  for (const relativePath of plan.directories || []) {
    keep.add(relativePath);
  }
  for (const relativePath of plan.optionalDirectories || []) {
    if (existsSync(path.join(packageRoot, relativePath))) {
      keep.add(relativePath);
    }
  }

  pruneToKeep(packageRoot, keep);
}

function shouldKeepPath(relativePath, keepPaths) {
  for (const keepPath of keepPaths) {
    if (keepPath === relativePath) {
      return true;
    }
    if (keepPath.startsWith(`${relativePath}${path.sep}`)) {
      return true;
    }
    if (relativePath.startsWith(`${keepPath}${path.sep}`)) {
      return true;
    }
  }

  return false;
}

function pruneToKeep(rootDir, keepPaths, relativeDir = '') {
  for (const entry of readdirSync(rootDir)) {
    const entryRelativePath = relativeDir ? path.join(relativeDir, entry) : entry;
    const fullPath = path.join(rootDir, entry);

    if (!shouldKeepPath(entryRelativePath, keepPaths)) {
      rmSync(fullPath, { recursive: true, force: true });
      continue;
    }

    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      pruneToKeep(fullPath, keepPaths, entryRelativePath);
    }
  }
}

function pruneStagedNodeModules() {
  if (!existsSync(STAGED_NODE_MODULES_ROOT)) {
    return;
  }

  for (const entry of readdirSync(STAGED_NODE_MODULES_ROOT)) {
    const packageRoot = path.join(STAGED_NODE_MODULES_ROOT, entry);
    const stats = statSync(packageRoot);

    if (!stats.isDirectory()) {
      rmSync(packageRoot, { force: true });
      continue;
    }

    const plan = FINAL_RUNTIME_PACKAGE_PLANS[entry];
    if (!plan) {
      rmSync(packageRoot, { recursive: true, force: true });
      continue;
    }

    keepOnly(packageRoot, plan);
  }
}

function logStageSizeSummary() {
  const componentPaths = [
    'main.cjs',
    'node_modules',
    'vscode-web-dist',
    'vscode-filesystem-provider',
    'vscode-scm-extension',
  ];
  const totalSize = getDirectorySize(stageBackendRoot);

  console.log('Final staged backend size summary:');
  for (const relativePath of componentPaths) {
    console.log(`  ${relativePath}: ${formatSize(getDirectorySize(path.join(stageBackendRoot, relativePath)))}`);
  }
  console.log(`  total: ${formatSize(totalSize)}`);

  if (totalSize > STAGED_BACKEND_WARN_THRESHOLD_BYTES) {
    console.warn(
      `Warning: staged backend exceeds ${formatSize(STAGED_BACKEND_WARN_THRESHOLD_BYTES)} (${formatSize(totalSize)})`,
    );
  }
}

function validateNativeRuntimeArtifacts() {
  const missingArtifacts = REQUIRED_NATIVE_RUNTIME_ARTIFACTS.filter((artifactPath) => !existsSync(artifactPath));
  if (missingArtifacts.length > 0) {
    throw new Error(
      [
        'Missing rebuilt native runtime artifacts in staged backend.',
        ...missingArtifacts.map((artifactPath) => `- ${artifactPath}`),
        'Run the Electron native rebuild step before archiving.',
      ].join('\n'),
    );
  }
}

function main() {
  if (!existsSync(stageBackendRoot)) {
    throw new Error(`Stage backend root is missing: ${stageBackendRoot}`);
  }

  validateNativeRuntimeArtifacts();
  pruneStagedNodeModules();
  logStageSizeSummary();

  execFileSync('tar', ['-czf', archivePath, '-C', stageBaseRoot, 'backend'], {
    cwd: repoRoot,
    stdio: 'inherit',
  });

  console.log(`Electron backend archive written to ${archivePath}`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
