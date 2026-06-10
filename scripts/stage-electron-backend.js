const { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } = require('fs');
const { execSync } = require('child_process');
const path = require('path');
const {
  assembleRuntime,
  formatSize,
  getDirectorySize,
  removeGitArtifacts,
  stagedVSCodeRoot,
} = require('./prepare-vscode-web-runtime');
const repoRoot = path.resolve(__dirname, '..');
const backendRoot = path.join(repoRoot, 'apps', 'backend');
const backendBundleRoot = path.join(backendRoot, 'bundle');
const stageBaseRoot = path.join(repoRoot, 'apps', 'electron', '.stage');
const stageBackendRoot = path.join(stageBaseRoot, 'backend');
const backendPackageJson = require(path.join(backendRoot, 'package.json'));
const NATIVE_RUNTIME_DEPENDENCIES = ['better-sqlite3', 'node-pty'];
const EMBED_LOCAL_CODEX_BINARY = process.env.ELEVENEX_EMBED_LOCAL_CODEX === '1';
const EMBED_LOCAL_NODE_RUNTIME = process.env.ELEVENEX_EMBED_LOCAL_NODE === '1';
const CODEX_PLATFORM_PACKAGE_BY_TARGET = {
  'x86_64-unknown-linux-musl': '@openai/codex-linux-x64',
  'aarch64-unknown-linux-musl': '@openai/codex-linux-arm64',
  'x86_64-apple-darwin': '@openai/codex-darwin-x64',
  'aarch64-apple-darwin': '@openai/codex-darwin-arm64',
  'x86_64-pc-windows-msvc': '@openai/codex-win32-x64',
  'aarch64-pc-windows-msvc': '@openai/codex-win32-arm64',
};
const STAGE_COPY_PLANS = {
  'better-sqlite3': {
    files: ['package.json', 'binding.gyp', 'LICENSE'],
    directories: ['lib', 'src', 'deps'],
    optionalDirectories: ['build', 'prebuilds', 'compiled'],
  },
  'node-pty': {
    files: ['package.json', 'binding.gyp', 'LICENSE'],
    directories: ['lib', 'scripts', 'src', 'deps', 'third_party', 'typings'],
    optionalDirectories: ['build', 'prebuilds', 'compiled'],
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

function ensureDir(dirPath) {
  mkdirSync(dirPath, { recursive: true });
}

function resetStageRoot() {
  rmSync(stageBaseRoot, { recursive: true, force: true });
  ensureDir(stageBackendRoot);
}

function copyDependencyTree(packageName, searchPaths) {
  const source = resolveInstalledPackagePath(packageName, searchPaths);
  const destination = path.join(stageBackendRoot, 'node_modules', packageName);
  const copyPlan = STAGE_COPY_PLANS[packageName];

  if (!copyPlan) {
    copyRequiredPath(source, destination, { dereference: true });
    return;
  }

  ensureDir(destination);
  for (const relativePath of copyPlan.files) {
    copyRequiredPath(path.join(source, relativePath), path.join(destination, relativePath), { dereference: true });
  }
  for (const relativePath of copyPlan.directories) {
    copyRequiredPath(path.join(source, relativePath), path.join(destination, relativePath), { dereference: true });
  }
  for (const relativePath of copyPlan.optionalDirectories || []) {
    copyPathIfExists(path.join(source, relativePath), path.join(destination, relativePath), { dereference: true });
  }
}

function resolveInstalledPackagePath(packageName, searchPaths = [backendRoot, repoRoot]) {
  const packageParts = packageName.split('/');
  for (const searchPath of searchPaths) {
    let dir = path.resolve(searchPath);
    while (true) {
      const candidate = path.join(dir, 'node_modules', ...packageParts);
      if (existsSync(path.join(candidate, 'package.json'))) {
        return realpathSync(candidate);
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  const manifestPath = require.resolve(`${packageName}/package.json`, {
    paths: searchPaths,
  });

  return path.dirname(manifestPath);
}

function copyRequiredPath(source, destination, options = {}) {
  if (!existsSync(source)) {
    throw new Error(`Required path is missing: ${source}`);
  }

  ensureDir(path.dirname(destination));
  cpSync(source, destination, { recursive: true, ...options });
}

function copyPathIfExists(source, destination, options = {}) {
  if (!existsSync(source)) {
    return;
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

function stageExtensionRuntime(extensionDirName) {
  const sourceRoot = path.join(repoRoot, extensionDirName);
  const destinationRoot = path.join(stageBackendRoot, extensionDirName);

  ensureDir(destinationRoot);
  copyRequiredPath(path.join(sourceRoot, 'dist'), path.join(destinationRoot, 'dist'));
  copyRequiredPath(path.join(sourceRoot, 'package.json'), path.join(destinationRoot, 'package.json'));

  const packageNlsPath = path.join(sourceRoot, 'package.nls.json');
  if (existsSync(packageNlsPath)) {
    copyRequiredPath(packageNlsPath, path.join(destinationRoot, 'package.nls.json'));
  }

  removeSourceMaps(destinationRoot);
}

function writeStagedBackendPackageJson() {
  const stagedPackageJson = {
    name: 'elevenex-embedded-backend',
    private: true,
    type: 'commonjs',
    dependencies: Object.fromEntries(
      NATIVE_RUNTIME_DEPENDENCIES.map((name) => [name, backendPackageJson.dependencies[name]]),
    ),
  };

  copyRequiredPath(
    path.join(backendRoot, 'package.json'),
    path.join(stageBackendRoot, 'package.json'),
  );

  writeFileSync(
    path.join(stageBackendRoot, 'package.json'),
    `${JSON.stringify(stagedPackageJson, null, 2)}\n`,
  );
}

function stageBundledNodeRuntime() {
  const nodeRoot = path.join(stageBackendRoot, 'node');
  rmSync(nodeRoot, { recursive: true, force: true });
  ensureDir(nodeRoot);

  if (process.platform === 'win32') {
    const sourceDir = path.dirname(process.execPath);
    copyRequiredPath(process.execPath, path.join(nodeRoot, 'node.exe'), { dereference: true });

    for (const entry of readdirSync(sourceDir)) {
      if (entry.toLowerCase().endsWith('.dll')) {
        copyRequiredPath(path.join(sourceDir, entry), path.join(nodeRoot, entry), { dereference: true });
      }
    }
    return;
  }

  const destination = path.join(nodeRoot, 'bin', 'node');
  copyRequiredPath(process.execPath, destination, { dereference: true });
  chmodSync(destination, 0o755);
}

function stageNativePackageTree(packageName, seen = new Set(), searchPaths = [backendRoot, repoRoot]) {
  if (seen.has(packageName)) {
    return;
  }

  seen.add(packageName);
  copyDependencyTree(packageName, searchPaths);

  const packageRoot = resolveInstalledPackagePath(packageName, searchPaths);
  const manifestPath = path.join(packageRoot, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const nestedDependencies = {
    ...(manifest.dependencies || {}),
    ...(manifest.optionalDependencies || {}),
  };

  for (const dependencyName of Object.keys(nestedDependencies)) {
    stageNativePackageTree(dependencyName, seen, [packageRoot, backendRoot, repoRoot]);
  }
}

function stageCodexRuntime() {
  const triple = codexTargetTriple();
  const platformPackage = triple ? CODEX_PLATFORM_PACKAGE_BY_TARGET[triple] : null;
  if (!platformPackage) {
    console.warn(`Skipping embedded Codex binary for unsupported platform ${process.platform}/${process.arch}`);
    return;
  }

  const sdkRoot = resolveInstalledPackagePath('@openai/codex-sdk', [backendRoot, repoRoot]);
  copyDependencyTree('@openai/codex-sdk', [backendRoot, repoRoot]);

  const codexRoot = resolveInstalledPackagePath('@openai/codex', [sdkRoot, backendRoot, repoRoot]);
  copyDependencyTree('@openai/codex', [sdkRoot, backendRoot, repoRoot]);
  copyDependencyTree(platformPackage, [codexRoot, sdkRoot, backendRoot, repoRoot]);
}

function main() {
  resetStageRoot();
  assembleRuntime();

  copyRequiredPath(path.join(backendBundleRoot, 'main.cjs'), path.join(stageBackendRoot, 'main.cjs'));
  copyRequiredPath(path.join(backendRoot, 'drizzle'), path.join(stageBackendRoot, 'drizzle'));
  copyRequiredPath(path.join(backendRoot, 'bin'), path.join(stageBackendRoot, 'bin'));
  ensureDir(path.join(stageBackendRoot, 'node_modules'));
  const stagedNativePackages = new Set();
  for (const packageName of NATIVE_RUNTIME_DEPENDENCIES) {
    stageNativePackageTree(packageName, stagedNativePackages);
  }
  if (EMBED_LOCAL_CODEX_BINARY) {
    stageCodexRuntime();
  } else {
    console.log('Skipping embedded Codex binary for local runtime (set ELEVENEX_EMBED_LOCAL_CODEX=1 to include it)');
  }
  if (EMBED_LOCAL_NODE_RUNTIME) {
    stageBundledNodeRuntime();
  } else {
    console.log('Skipping bundled Node for local runtime; packaged app will use Electron-as-Node');
  }
  writeStagedBackendPackageJson();
  copyRequiredPath(path.join(repoRoot, 'apps', 'frontend', 'proxy.conf.json'), path.join(stageBackendRoot, 'proxy.conf.json'));
  copyRequiredPath(stagedVSCodeRoot, path.join(stageBackendRoot, 'vscode-web-dist'));
  stageExtensionRuntime('vscode-filesystem-provider');
  stageExtensionRuntime('vscode-scm-extension');
  removeSourceMaps(stageBackendRoot);
  removeGitArtifacts(stageBackendRoot);

  const componentSizes = {
    'main.cjs': getDirectorySize(path.join(stageBackendRoot, 'main.cjs')),
    node: getDirectorySize(path.join(stageBackendRoot, 'node')),
    'node_modules': getDirectorySize(path.join(stageBackendRoot, 'node_modules')),
    'vscode-web-dist': getDirectorySize(path.join(stageBackendRoot, 'vscode-web-dist')),
    'vscode-filesystem-provider': getDirectorySize(path.join(stageBackendRoot, 'vscode-filesystem-provider')),
    'vscode-scm-extension': getDirectorySize(path.join(stageBackendRoot, 'vscode-scm-extension')),
  };

  const commitSha = execSync('git rev-parse HEAD', { cwd: repoRoot }).toString().trim();
  writeFileSync(path.join(stageBackendRoot, 'version'), commitSha, 'utf8');
  writeFileSync(path.join(stageBaseRoot, 'version'), commitSha, 'utf8');

  console.log(`Electron backend staged at ${stageBackendRoot}`);
  for (const [name, size] of Object.entries(componentSizes)) {
    console.log(`  ${name}: ${formatSize(size)}`);
  }
  console.log(`  total: ${formatSize(getDirectorySize(stageBackendRoot))}`);
}

main();
