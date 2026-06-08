const { existsSync } = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const electronAppRoot = path.join(repoRoot, 'apps', 'electron');
const stageBackendRoot = path.join(electronAppRoot, '.stage', 'backend');
const NATIVE_RUNTIME_DEPENDENCIES = ['better-sqlite3', 'node-pty'];

function resolveModule(request) {
  return require.resolve(request, {
    paths: [electronAppRoot, repoRoot, __dirname],
  });
}

function loadElectronRebuild() {
  return require(resolveModule('@electron/rebuild'));
}

function getInstalledElectronVersion() {
  const electronPackageJson = resolveModule('electron/package.json');
  return require(electronPackageJson).version;
}

function getBundledNodeExecutable() {
  const candidates = process.platform === 'win32'
    ? [path.join(stageBackendRoot, 'node', 'node.exe')]
    : [path.join(stageBackendRoot, 'node', 'bin', 'node')];

  return candidates.find((candidate) => existsSync(candidate)) || null;
}

function validateBundledNodeRuntime(nodeExecutable) {
  const script = [
    "const path = require('path');",
    "const root = process.argv[1];",
    "const Database = require(path.join(root, 'node_modules', 'better-sqlite3'));",
    "const db = new Database(':memory:');",
    "db.prepare('select 1 as ok').get();",
    "db.close();",
    "require(path.join(root, 'node_modules', 'node-pty'));",
  ].join('');

  const result = spawnSync(nodeExecutable, ['-e', script, stageBackendRoot], {
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
        `Bundled Node runtime native smoke test failed with exit code ${result.status ?? 'unknown'}.`,
        result.stderr.trim(),
        result.stdout.trim(),
      ].filter(Boolean).join('\n'),
    );
  }
}

async function main() {
  if (!existsSync(stageBackendRoot)) {
    throw new Error(`Stage backend root is missing: ${stageBackendRoot}`);
  }

  const bundledNode = getBundledNodeExecutable();
  if (bundledNode) {
    validateBundledNodeRuntime(bundledNode);
    console.log(`Validated native backend modules with bundled Node at ${bundledNode}`);
    return;
  }

  const { rebuild } = loadElectronRebuild();
  await rebuild({
    buildPath: stageBackendRoot,
    electronVersion: getInstalledElectronVersion(),
    arch: process.arch,
    onlyModules: NATIVE_RUNTIME_DEPENDENCIES,
    force: true,
  });

  console.log(`Rebuilt native backend modules for Electron in ${stageBackendRoot}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
