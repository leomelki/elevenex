const { existsSync } = require('fs');
const path = require('path');

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

async function main() {
  if (!existsSync(stageBackendRoot)) {
    throw new Error(`Stage backend root is missing: ${stageBackendRoot}`);
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
