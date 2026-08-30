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
const NATIVE_RUNTIME_DEPENDENCIES = ['better-sqlite3', 'node-pty', '@vscode/ripgrep', 'onnxruntime-node'];
const EMBED_LOCAL_NODE_RUNTIME = process.env.ELEVENEX_EMBED_LOCAL_NODE === '1';
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
  '@vscode/ripgrep': {
    files: ['package.json', 'LICENSE'],
    directories: ['lib'],
  },
  '@vscode/ripgrep-darwin-arm64': {
    files: ['package.json'],
    directories: ['bin'],
  },
  '@vscode/ripgrep-darwin-x64': {
    files: ['package.json'],
    directories: ['bin'],
  },
  '@vscode/ripgrep-linux-arm64': {
    files: ['package.json'],
    directories: ['bin'],
  },
  '@vscode/ripgrep-linux-arm': {
    files: ['package.json'],
    directories: ['bin'],
  },
  '@vscode/ripgrep-linux-ia32': {
    files: ['package.json'],
    directories: ['bin'],
  },
  '@vscode/ripgrep-linux-ppc64': {
    files: ['package.json'],
    directories: ['bin'],
  },
  '@vscode/ripgrep-linux-riscv64': {
    files: ['package.json'],
    directories: ['bin'],
  },
  '@vscode/ripgrep-linux-s390x': {
    files: ['package.json'],
    directories: ['bin'],
  },
  '@vscode/ripgrep-linux-x64': {
    files: ['package.json'],
    directories: ['bin'],
  },
  '@vscode/ripgrep-win32-arm64': {
    files: ['package.json'],
    directories: ['bin'],
  },
  '@vscode/ripgrep-win32-ia32': {
    files: ['package.json'],
    directories: ['bin'],
  },
  '@vscode/ripgrep-win32-x64': {
    files: ['package.json'],
    directories: ['bin'],
  },
  // ONNX Runtime publishes every platform's binaries in one package (~210 MB
  // unpacked). Only the host's own build can ever load, so stage just that one
  // and leave the other ~150 MB out of the installer.
  'onnxruntime-node': {
    files: ['package.json', 'README.md'],
    directories: ['dist', 'lib'],
    optionalDirectories: [
      path.join('bin', 'napi-v6', process.platform, process.arch),
    ],
  },
  '@openai/codex-sdk': {
    files: ['package.json', 'LICENSE'],
    directories: ['dist'],
  },
  '@anthropic-ai/claude-agent-sdk': {
    files: ['package.json'],
    directories: [],
  },
};

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
    try {
      stageNativePackageTree(dependencyName, seen, [packageRoot, backendRoot, repoRoot]);
    } catch (error) {
      if ((manifest.optionalDependencies || {})[dependencyName]) {
        continue;
      }
      throw error;
    }
  }
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
  // The backend dynamically imports the small JavaScript SDK for lightweight
  // Codex generation. Stage only its JS files; never traverse its dependency
  // on @openai/codex, which is where the native CLI payload is published.
  copyDependencyTree('@openai/codex-sdk', [backendRoot, repoRoot]);
  // Claude's JS SDK is part of main.cjs; retain only its package metadata for
  // runtime compatibility diagnostics, not any platform CLI package.
  copyDependencyTree('@anthropic-ai/claude-agent-sdk', [backendRoot, repoRoot]);
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
