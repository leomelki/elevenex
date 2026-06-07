const { execFileSync, execSync } = require('child_process');
const { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } = require('fs');
const { join } = require('path');

const root = join(__dirname, '..');
const extensionToolchainPackages = ['webpack', 'webpack-cli', 'ts-loader', 'typescript', 'mocha'];

function ensureSymlink(targetPath, linkPath, type = 'dir') {
  rmSync(linkPath, { recursive: true, force: true });
  symlinkSync(targetPath, linkPath, process.platform === 'win32' && type === 'dir' ? 'junction' : type);
}

function ensureBinShim(binName, entryPath, binDir) {
  const shellShim = join(binDir, binName);
  rmSync(shellShim, { force: true });

  if (process.platform === 'win32') {
    const cmdShim = join(binDir, `${binName}.cmd`);
    const psShim = join(binDir, `${binName}.ps1`);
    rmSync(cmdShim, { force: true });
    rmSync(psShim, { force: true });

    writeFileSync(cmdShim, `@ECHO off\r\nnode "%~dp0\\${entryPath.replaceAll('/', '\\')}" %*\r\n`, 'utf8');
    writeFileSync(psShim, `& node "$PSScriptRoot/${entryPath}" @args\r\nexit $LASTEXITCODE\r\n`, 'utf8');
    return;
  }

  ensureSymlink(entryPath, shellShim, 'file');
  chmodSync(shellShim, 0o755);
}

function findPnpmPackageRoot(packageName) {
  const pnpmRoot = join(root, 'node_modules', '.pnpm');
  const packageSuffix = join('node_modules', ...packageName.split('/'), 'package.json');

  const candidates = readdirSync(pnpmRoot)
    .map((entry) => join(pnpmRoot, entry, packageSuffix))
    .filter((candidate) => existsSync(candidate))
    .sort()
    .reverse();

  if (candidates.length === 0) {
    throw new Error(`Could not resolve ${packageName} from pnpm store`);
  }

  return join(candidates[0], '..');
}

function prepareExtensionToolchain(packageDir) {
  const nodeModulesDir = join(packageDir, 'node_modules');
  const binDir = join(nodeModulesDir, '.bin');
  mkdirSync(binDir, { recursive: true });

  for (const packageName of extensionToolchainPackages) {
    const packageRoot = findPnpmPackageRoot(packageName);
    const liveDir = join(nodeModulesDir, packageName);
    ensureSymlink(packageRoot, liveDir, 'dir');
  }

  const webpackCliEntry = join(nodeModulesDir, 'webpack-cli', 'bin', 'cli.js');
  if (existsSync(webpackCliEntry)) {
    ensureBinShim('webpack', '../webpack-cli/bin/cli.js', binDir);
    ensureBinShim('webpack-cli', '../webpack-cli/bin/cli.js', binDir);
  }
}

function buildExtension(packageDir) {
  prepareExtensionToolchain(packageDir);

  const webpackCliEntry = join(packageDir, 'node_modules', 'webpack-cli', 'bin', 'cli.js');
  if (!existsSync(webpackCliEntry)) {
    throw new Error(`webpack-cli entrypoint not found for ${packageDir}`);
  }

  execFileSync(process.execPath, [webpackCliEntry, '--mode', 'production'], {
    cwd: packageDir,
    stdio: 'inherit',
  });
}

// 1. Build custom VS Code extensions
console.log('Building VS Code extensions...');
try {
  buildExtension(join(root, 'vscode-filesystem-provider'));
  buildExtension(join(root, 'vscode-scm-extension'));
} catch (e) {
  console.error('Failed to build VS Code extensions:', e.message);
  process.exit(1);
}

// 2. Generate favicon assets from the canonical logo source
console.log('Generating Elevenex favicon assets...');
try {
  execSync('pnpm assets:icons', { cwd: root, stdio: 'inherit' });
} catch (e) {
  console.error('Failed to generate favicon assets:', e.message);
  process.exit(1);
}

console.log('Done.');
