const { existsSync, readdirSync } = require('fs');
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

function validateNativeRuntime(nodeExecutable, env = process.env) {
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
        `Native backend module smoke test failed with exit code ${result.status ?? 'unknown'}.`,
        result.stderr.trim(),
        result.stdout.trim(),
      ].filter(Boolean).join('\n'),
    );
  }
}

function resolveNodeGypEntrypoint() {
  const pnpmRoot = path.join(repoRoot, 'node_modules', '.pnpm');
  const packageDir = readdirSync(pnpmRoot)
    .filter((entry) => entry.startsWith('node-gyp@'))
    .sort(
      (left, right) =>
        Number.parseInt(right.slice('node-gyp@'.length), 10) -
        Number.parseInt(left.slice('node-gyp@'.length), 10),
    )[0];
  if (!packageDir) throw new Error('Could not locate node-gyp');
  const entrypoint = path.join(
    pnpmRoot,
    packageDir,
    'node_modules',
    'node-gyp',
    'bin',
    'node-gyp.js',
  );
  if (!existsSync(entrypoint)) {
    throw new Error(`node-gyp entrypoint is missing: ${entrypoint}`);
  }
  return entrypoint;
}

function rebuildForElectron(moduleName, electronVersion) {
  const moduleRoot = path.join(stageBackendRoot, 'node_modules', moduleName);
  const result = spawnSync(
    process.execPath,
    [
      resolveNodeGypEntrypoint(),
      'rebuild',
      '--release',
      `--target=${electronVersion}`,
      `--arch=${process.arch}`,
      '--dist-url=https://electronjs.org/headers',
    ],
    { cwd: moduleRoot, env: process.env, stdio: 'inherit' },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Failed to rebuild ${moduleName} for Electron ${electronVersion}`,
    );
  }
}

async function main() {
  if (!existsSync(stageBackendRoot)) {
    throw new Error(`Stage backend root is missing: ${stageBackendRoot}`);
  }

  const bundledNode = getBundledNodeExecutable();
  if (bundledNode) {
    validateNativeRuntime(bundledNode);
    console.log(`Validated native backend modules with bundled Node at ${bundledNode}`);
    return;
  }

  const electronVersion = getInstalledElectronVersion();
  for (const moduleName of NATIVE_RUNTIME_DEPENDENCIES) {
    rebuildForElectron(moduleName, electronVersion);
  }

  const electronExecutable = require(resolveModule('electron'));
  validateNativeRuntime(electronExecutable, {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
  });
  console.log(
    `Rebuilt and validated native backend modules for Electron ${electronVersion} in ${stageBackendRoot}`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
