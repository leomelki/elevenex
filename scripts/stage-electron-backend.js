const { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } = require('fs');
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
const NATIVE_RUNTIME_DEPENDENCIES = [
  '@anthropic-ai/claude-agent-sdk',
  'better-sqlite3',
  'node-pty',
  'zod',
];
const STAGE_COPY_PLANS = {
  'better-sqlite3': {
    files: ['package.json', 'binding.gyp', 'LICENSE'],
    directories: ['lib', 'src', 'deps'],
  },
  'node-pty': {
    files: ['package.json', 'binding.gyp', 'LICENSE'],
    directories: ['lib', 'scripts', 'src', 'deps', 'third_party', 'typings'],
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
}

function resolveInstalledPackagePath(packageName, searchPaths = [backendRoot, repoRoot]) {
  try {
    const manifestPath = require.resolve(`${packageName}/package.json`, {
      paths: searchPaths,
    });

    return path.dirname(manifestPath);
  } catch (error) {
    if (error?.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') {
      throw error;
    }
  }

  const entryPath = require.resolve(packageName, { paths: searchPaths });
  let current = path.dirname(entryPath);
  while (current !== path.dirname(current)) {
    const manifestPath = path.join(current, 'package.json');
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (manifest.name === packageName) {
        return current;
      }
    }

    current = path.dirname(current);
  }

  throw new Error(`Could not locate package root for ${packageName}`);
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
  const dependencyVersions = Object.fromEntries(
    NATIVE_RUNTIME_DEPENDENCIES.map((name) => [
      name,
      backendPackageJson.dependencies[name]
        ?? readInstalledPackageVersion(name, getRuntimeDependencySearchPaths(name)),
    ]),
  );
  const stagedPackageJson = {
    name: 'elevenex-embedded-backend',
    private: true,
    type: 'commonjs',
    dependencies: dependencyVersions,
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

function readInstalledPackageVersion(packageName, searchPaths = [backendRoot, repoRoot]) {
  const packageRoot = resolveInstalledPackagePath(packageName, searchPaths);
  const manifestPath = path.join(packageRoot, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

  if (!manifest.version) {
    throw new Error(`Could not determine installed version for ${packageName}`);
  }

  return manifest.version;
}

function getRuntimeDependencySearchPaths(packageName) {
  if (packageName === 'zod') {
    return [
      resolveInstalledPackagePath('@anthropic-ai/claude-agent-sdk'),
      backendRoot,
      repoRoot,
    ];
  }

  return [backendRoot, repoRoot];
}

function isMissingOptionalPackageError(error) {
  return error?.code === 'MODULE_NOT_FOUND';
}

function stageNativePackageTree(packageName, seen = new Set(), searchPaths = [backendRoot, repoRoot], required = true) {
  if (seen.has(packageName)) {
    return;
  }

  seen.add(packageName);
  let packageRoot;
  try {
    packageRoot = resolveInstalledPackagePath(packageName, searchPaths);
    copyDependencyTree(packageName, searchPaths);
  } catch (error) {
    if (!required && isMissingOptionalPackageError(error)) {
      return;
    }

    throw error;
  }

  const manifestPath = path.join(packageRoot, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const requiredDependencies = {
    ...(manifest.dependencies || {}),
    ...(manifest.peerDependencies || {}),
  };

  for (const dependencyName of Object.keys(requiredDependencies)) {
    stageNativePackageTree(dependencyName, seen, [packageRoot, backendRoot, repoRoot]);
  }
  for (const dependencyName of Object.keys(manifest.optionalDependencies || {})) {
    stageNativePackageTree(dependencyName, seen, [packageRoot, backendRoot, repoRoot], false);
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
    stageNativePackageTree(
      packageName,
      stagedNativePackages,
      getRuntimeDependencySearchPaths(packageName),
    );
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
