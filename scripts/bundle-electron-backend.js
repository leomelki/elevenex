const { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const backendRoot = path.join(repoRoot, 'apps', 'backend');
const backendDistEntry = path.join(backendRoot, 'dist', 'src', 'main.js');
const backendBundleRoot = path.join(backendRoot, 'bundle');
const backendBundleEntry = path.join(backendBundleRoot, 'main.cjs');
const EXTERNAL_MODULES = [
  'better-sqlite3',
  'node-pty',
  '@nestjs/microservices',
  '@nestjs/microservices/microservices-module',
];

function findEsbuildModule() {
  const pnpmRoot = path.join(repoRoot, 'node_modules', '.pnpm');
  if (!existsSync(pnpmRoot)) {
    throw new Error('Could not find node_modules/.pnpm to resolve esbuild');
  }

  const candidates = readdirSync(pnpmRoot)
    .filter((entry) => entry.startsWith('esbuild@'))
    .map((entry) => path.join(pnpmRoot, entry, 'node_modules', 'esbuild', 'lib', 'main.js'))
    .filter((candidate) => existsSync(candidate))
    .sort()
    .reverse();

  if (candidates.length === 0) {
    throw new Error('Could not locate esbuild in node_modules/.pnpm');
  }

  return candidates[0];
}

function findPnpmPackageRoot(packageName) {
  const pnpmRoot = path.join(repoRoot, 'node_modules', '.pnpm');
  const packageSuffix = path.join('node_modules', ...packageName.split('/'), 'package.json');

  const candidates = readdirSync(pnpmRoot)
    .map((entry) => path.join(pnpmRoot, entry, packageSuffix))
    .filter((candidate) => existsSync(candidate))
    .sort()
    .reverse();

  if (candidates.length === 0) {
    throw new Error(`Could not resolve ${packageName} from pnpm store`);
  }

  return path.dirname(candidates[0]);
}

function createPnpmAliasPlugin(packageName) {
  return {
    name: `alias-${packageName.replace(/[\/@]/g, '-')}`,
    setup(build) {
      build.onResolve({ filter: new RegExp(`^${packageName.replace('/', '\\/')}$`) }, () => {
        const packageRoot = findPnpmPackageRoot(packageName);
        const packageJson = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
        return {
          path: path.join(packageRoot, packageJson.main || 'index.js'),
        };
      });
    },
  };
}

async function main() {
  if (!existsSync(backendDistEntry)) {
    throw new Error(`Backend build output is missing: ${backendDistEntry}`);
  }

  rmSync(backendBundleRoot, { recursive: true, force: true });
  mkdirSync(backendBundleRoot, { recursive: true });

  const esbuild = require(findEsbuildModule());
  await esbuild.build({
    entryPoints: [backendDistEntry],
    outfile: backendBundleEntry,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    sourcemap: false,
    minify: false,
    legalComments: 'none',
    external: EXTERNAL_MODULES,
    plugins: [createPnpmAliasPlugin('express')],
    logLevel: 'info',
  });

  console.log(`Electron backend bundle written to ${backendBundleEntry}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
