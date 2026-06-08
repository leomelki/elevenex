const { existsSync, readdirSync, rmSync, statSync } = require('fs');
const { execFileSync, spawnSync } = require('child_process');
const path = require('path');
const { formatSize, getDirectorySize } = require('./prepare-vscode-web-runtime');

const repoRoot = path.resolve(__dirname, '..');
const electronAppRoot = path.join(repoRoot, 'apps', 'electron');
const stageBaseRoot = path.join(repoRoot, 'apps', 'electron', '.stage');
const stageBackendRoot = path.join(stageBaseRoot, 'backend');
const archivePath = path.join(stageBaseRoot, 'backend.tar.gz');
const STAGED_NODE_MODULES_ROOT = path.join(stageBackendRoot, 'node_modules');
const STAGED_BACKEND_WARN_THRESHOLD_BYTES = 110 * 1024 * 1024;
const CODEX_PLATFORM_PACKAGE_BY_TARGET = {
  'x86_64-unknown-linux-musl': '@openai/codex-linux-x64',
  'aarch64-unknown-linux-musl': '@openai/codex-linux-arm64',
  'x86_64-apple-darwin': '@openai/codex-darwin-x64',
  'aarch64-apple-darwin': '@openai/codex-darwin-arm64',
  'x86_64-pc-windows-msvc': '@openai/codex-win32-x64',
  'aarch64-pc-windows-msvc': '@openai/codex-win32-arm64',
};
const NODE_PTY_PLATFORM_PREBUILDS_ROOT = path.join(
  STAGED_NODE_MODULES_ROOT,
  'node-pty',
  'prebuilds',
  `${process.platform}-${process.arch}`,
);
const REQUIRED_NATIVE_RUNTIME_ARTIFACTS = [
  {
    label: 'better-sqlite3',
    alternatives: [
      path.join(STAGED_NODE_MODULES_ROOT, 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'),
    ],
  },
  {
    label: 'node-pty pty',
    alternatives: [
      path.join(STAGED_NODE_MODULES_ROOT, 'node-pty', 'build', 'Release', 'pty.node'),
      path.join(NODE_PTY_PLATFORM_PREBUILDS_ROOT, 'pty.node'),
    ],
  },
  ...(process.platform === 'win32'
    ? [
        {
          label: 'node-pty conpty',
          alternatives: [
            path.join(STAGED_NODE_MODULES_ROOT, 'node-pty', 'build', 'Release', 'conpty.node'),
            path.join(NODE_PTY_PLATFORM_PREBUILDS_ROOT, 'conpty.node'),
          ],
        },
      ]
    : []),
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
  '@openai/codex-sdk': {
    files: ['package.json', 'LICENSE'],
    directories: ['dist'],
  },
  '@openai/codex': {
    files: ['package.json'],
    directories: ['bin'],
  },
  '@openai/codex-darwin-arm64': {
    files: ['package.json'],
    directories: ['vendor'],
  },
  '@openai/codex-darwin-x64': {
    files: ['package.json'],
    directories: ['vendor'],
  },
  '@openai/codex-linux-arm64': {
    files: ['package.json'],
    directories: ['vendor'],
  },
  '@openai/codex-linux-x64': {
    files: ['package.json'],
    directories: ['vendor'],
  },
  '@openai/codex-win32-arm64': {
    files: ['package.json'],
    directories: ['vendor'],
  },
  '@openai/codex-win32-x64': {
    files: ['package.json'],
    directories: ['vendor'],
  },
};

function codexTargetTriple() {
  const { platform, arch } = process;
  if (platform === 'linux' || platform === 'android') {
    if (arch === 'x64') return 'x86_64-unknown-linux-musl';
    if (arch === 'arm64') return 'aarch64-unknown-linux-musl';
    return null;
  }
  if (platform === 'darwin') {
    if (arch === 'x64') return 'x86_64-apple-darwin';
    if (arch === 'arm64') return 'aarch64-apple-darwin';
    return null;
  }
  if (platform === 'win32') {
    if (arch === 'x64') return 'x86_64-pc-windows-msvc';
    if (arch === 'arm64') return 'aarch64-pc-windows-msvc';
    return null;
  }
  return null;
}

function scopedPackagePath(packageName) {
  return path.join(STAGED_NODE_MODULES_ROOT, ...packageName.split('/'));
}

function codexBinaryPath() {
  const triple = codexTargetTriple();
  if (!triple) return null;
  const platformPackage = CODEX_PLATFORM_PACKAGE_BY_TARGET[triple];
  if (!platformPackage) return null;
  const binaryName = process.platform === 'win32' ? 'codex.exe' : 'codex';
  return path.join(
    scopedPackagePath(platformPackage),
    'vendor',
    triple,
    'codex',
    binaryName,
  );
}

function keepOnly(packageRoot, plan) {
  if (!existsSync(packageRoot)) {
    return;
  }

  const keep = new Set();
  const addKeep = (relativePath) => {
    keep.add(path.normalize(relativePath));
  };
  for (const relativePath of plan.files || []) {
    addKeep(relativePath);
  }
  for (const relativePath of plan.optionalFiles || []) {
    if (existsSync(path.join(packageRoot, relativePath))) {
      addKeep(relativePath);
    }
  }
  for (const relativePath of plan.directories || []) {
    addKeep(relativePath);
  }
  for (const relativePath of plan.optionalDirectories || []) {
    if (existsSync(path.join(packageRoot, relativePath))) {
      addKeep(relativePath);
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

    if (entry.startsWith('@')) {
      pruneScopedPackages(entry, packageRoot);
      continue;
    }

    prunePackage(entry, packageRoot);
  }
}

function pruneScopedPackages(scopeName, scopeRoot) {
  for (const entry of readdirSync(scopeRoot)) {
    const packageRoot = path.join(scopeRoot, entry);
    const stats = statSync(packageRoot);
    if (!stats.isDirectory()) {
      rmSync(packageRoot, { force: true });
      continue;
    }
    prunePackage(`${scopeName}/${entry}`, packageRoot);
  }

  if (readdirSync(scopeRoot).length === 0) {
    rmSync(scopeRoot, { recursive: true, force: true });
  }
}

function prunePackage(packageName, packageRoot) {
  const plan = FINAL_RUNTIME_PACKAGE_PLANS[packageName];
  if (!plan) {
    rmSync(packageRoot, { recursive: true, force: true });
    return;
  }

  keepOnly(packageRoot, plan);
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
  const codexBin = codexBinaryPath();
  const requiredArtifacts = [
    ...REQUIRED_NATIVE_RUNTIME_ARTIFACTS,
    ...(codexBin
      ? [
          {
            label: 'Codex embedded binary',
            alternatives: [codexBin],
          },
        ]
      : []),
  ];
  const missingArtifacts = requiredArtifacts.filter(
    (artifact) =>
      !artifact.alternatives.some((artifactPath) => existsSync(artifactPath)),
  );
  if (missingArtifacts.length > 0) {
    throw new Error(
      [
        'Missing rebuilt native runtime artifacts in staged backend.',
        ...missingArtifacts.map(
          (artifact) =>
            `- ${artifact.label}: expected one of ${artifact.alternatives.join(', ')}`,
        ),
        'Run the Electron native rebuild step before archiving.',
      ].join('\n'),
    );
  }
}

function resolveModule(request) {
  return require.resolve(request, {
    paths: [electronAppRoot, repoRoot, __dirname],
  });
}

function getElectronExecutable() {
  return require(resolveModule('electron'));
}

function getBundledNodeExecutable() {
  const candidates = process.platform === 'win32'
    ? [path.join(stageBackendRoot, 'node', 'node.exe')]
    : [path.join(stageBackendRoot, 'node', 'bin', 'node')];

  return candidates.find((candidate) => existsSync(candidate)) || null;
}

function validateNativeRuntimeLoad() {
  const script = [
    "const path = require('path');",
    "const root = process.argv[1];",
    "const Database = require(path.join(root, 'node_modules', 'better-sqlite3'));",
    "const db = new Database(':memory:');",
    "db.prepare('select 1 as ok').get();",
    "db.close();",
    "require(path.join(root, 'node_modules', 'node-pty'));",
  ].join('');
  const bundledNode = getBundledNodeExecutable();
  const executable = bundledNode || getElectronExecutable();
  const env = bundledNode
    ? process.env
    : { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  const result = spawnSync(executable, ['-e', script, stageBackendRoot], {
    cwd: stageBackendRoot,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(
      [
        `Staged backend native smoke test failed with exit code ${result.status ?? 'unknown'}.`,
        result.stderr.trim(),
        result.stdout.trim(),
      ].filter(Boolean).join('\n'),
    );
  }

  console.log(`Validated staged native modules with ${bundledNode ? 'bundled Node' : 'Electron-as-Node'}`);
}

function validateCodexRuntimeLoad() {
  const codexBin = codexBinaryPath();
  if (!codexBin) {
    console.warn(`Skipping Codex binary smoke test for unsupported platform ${process.platform}/${process.arch}`);
    return;
  }

  const result = spawnSync(codexBin, ['--version'], {
    cwd: stageBackendRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(
      [
        `Staged Codex binary smoke test failed with exit code ${result.status ?? 'unknown'}.`,
        result.stderr.trim(),
        result.stdout.trim(),
      ].filter(Boolean).join('\n'),
    );
  }

  console.log(`Validated staged Codex binary: ${result.stdout.trim() || codexBin}`);
}

function main() {
  if (!existsSync(stageBackendRoot)) {
    throw new Error(`Stage backend root is missing: ${stageBackendRoot}`);
  }

  validateNativeRuntimeArtifacts();
  pruneStagedNodeModules();
  validateNativeRuntimeLoad();
  validateCodexRuntimeLoad();
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
