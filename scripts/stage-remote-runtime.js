const { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } = require('fs');
const https = require('https');
const path = require('path');
const { execSync, spawnSync } = require('child_process');
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
const remoteRuntimeRoot = path.join(stageBaseRoot, 'remote-runtime');
const tempRoot = path.join(stageBaseRoot, 'remote-runtime-tmp');
const backendPackageJson = require(path.join(backendRoot, 'package.json'));
const NODE_MAJOR = 22;
const TARGETS = [
  { key: 'linux-x64', platform: 'linux', arch: 'x64', nodeArch: 'x64' },
  { key: 'linux-arm64', platform: 'linux', arch: 'arm64', nodeArch: 'arm64' },
  { key: 'darwin-x64', platform: 'darwin', arch: 'x64', nodeArch: 'x64' },
  { key: 'darwin-arm64', platform: 'darwin', arch: 'arm64', nodeArch: 'arm64' },
  { key: 'win32-x64', platform: 'win32', arch: 'x64', nodeArch: 'x64', nodePlatform: 'win', archiveExtension: 'zip' },
];
const NATIVE_RUNTIME_DEPENDENCIES = ['better-sqlite3', 'node-pty', '@openai/codex-sdk', '@vscode/ripgrep'];

function ensureDir(targetPath) {
  mkdirSync(targetPath, { recursive: true });
}

function resetStageRoots() {
  rmSync(remoteRuntimeRoot, { recursive: true, force: true });
  rmSync(tempRoot, { recursive: true, force: true });
  ensureDir(remoteRuntimeRoot);
  ensureDir(tempRoot);
}

function copyRequiredPath(source, destination, options = {}) {
  if (!existsSync(source)) {
    throw new Error(`Required path is missing: ${source}`);
  }

  ensureDir(path.dirname(destination));
  cpSync(source, destination, { recursive: true, ...options });
}

// node-pty's prebuilt darwin/linux spawn-helper ships without the executable
// bit set when extracted through pnpm/prebuild-install on a foreign-arch host
// (CI builds the darwin bundle on Linux). Without +x every pty.spawn fails
// with `posix_spawnp failed`. Walk the staged tree and restore it.
function restoreSpawnHelperPermissions(rootDir) {
  if (!existsSync(rootDir)) {
    return;
  }

  for (const entry of readdirSync(rootDir)) {
    const fullPath = path.join(rootDir, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      restoreSpawnHelperPermissions(fullPath);
    } else if (entry === 'spawn-helper' && (stats.mode & 0o111) === 0) {
      chmodSync(fullPath, 0o755);
    }
  }
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

function stageExtensionRuntime(extensionDirName, destinationRoot) {
  const sourceRoot = path.join(repoRoot, extensionDirName);
  const extensionDestinationRoot = path.join(destinationRoot, extensionDirName);

  ensureDir(extensionDestinationRoot);
  copyRequiredPath(path.join(sourceRoot, 'dist'), path.join(extensionDestinationRoot, 'dist'));
  copyRequiredPath(path.join(sourceRoot, 'package.json'), path.join(extensionDestinationRoot, 'package.json'));

  const packageNlsPath = path.join(sourceRoot, 'package.nls.json');
  if (existsSync(packageNlsPath)) {
    copyRequiredPath(packageNlsPath, path.join(extensionDestinationRoot, 'package.nls.json'));
  }

  removeSourceMaps(extensionDestinationRoot);
}

function shouldBuildNativeDependenciesOnHost(target) {
  return target.platform === process.platform && target.arch === process.arch;
}

function buildRuntimePackageJson(target) {
  const onlyBuiltDependencies = shouldBuildNativeDependenciesOnHost(target)
    ? ['better-sqlite3', 'node-pty']
    : [];

  return {
    name: 'elevenex-remote-runtime',
    private: true,
    type: 'commonjs',
    pnpm: {
      onlyBuiltDependencies,
    },
    dependencies: Object.fromEntries(
      NATIVE_RUNTIME_DEPENDENCIES.map((name) => [name, backendPackageJson.dependencies[name]]),
    ),
  };
}

function buildChildEnv(overrides = {}) {
  const env = new Map();
  for (const [key, value] of Object.entries({ ...process.env, ...overrides })) {
    // Rebuilding a Windows env block can fail on hidden drive variables like =C:.
    if (!key || key.includes('=') || value === undefined || value === null) {
      continue;
    }

    const normalizedKey = process.platform === 'win32' ? key.toUpperCase() : key;
    env.set(normalizedKey, [key, String(value)]);
  }

  return Object.fromEntries([...env.values()]);
}

function quotePowerShellArgument(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function runCommand(command, args, options = {}) {
  const runViaPowerShell = process.platform === 'win32' && command === 'pnpm';
  const executable = runViaPowerShell ? 'powershell' : command;
  const commandArgs = runViaPowerShell
    ? [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        `& pnpm ${args.map(quotePowerShellArgument).join(' ')}`,
      ]
    : args;
  const displayCommand = `${command} ${args.join(' ')}`;
  const result = spawnSync(executable, commandArgs, {
    stdio: 'inherit',
    ...options,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`${displayCommand} failed with exit code ${result.status ?? 'unknown'}`);
  }
}

function fetchText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (response) => {
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        fetchText(response.headers.location).then(resolve, reject);
        return;
      }

      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`GET ${url} failed with status ${response.statusCode}`));
        return;
      }

      let data = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        data += chunk;
      });
      response.on('end', () => resolve(data));
      response.on('error', reject);
    }).on('error', reject);
  });
}

function downloadFile(url, destinationPath) {
  return new Promise((resolve, reject) => {
    ensureDir(path.dirname(destinationPath));
    const fileStream = require('fs').createWriteStream(destinationPath);
    https.get(url, (response) => {
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        fileStream.close();
        rmSync(destinationPath, { force: true });
        downloadFile(response.headers.location, destinationPath).then(resolve, reject);
        return;
      }

      if (response.statusCode !== 200) {
        response.resume();
        fileStream.close();
        rmSync(destinationPath, { force: true });
        reject(new Error(`Download failed for ${url}: ${response.statusCode}`));
        return;
      }

      response.pipe(fileStream);
      fileStream.on('finish', () => {
        fileStream.close(resolve);
      });
      fileStream.on('error', (error) => {
        fileStream.close(() => reject(error));
      });
    }).on('error', (error) => {
      fileStream.close(() => reject(error));
    });
  });
}

async function resolveLatestNodeVersion() {
  const text = await fetchText(`https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/SHASUMS256.txt`);
  const match = text.match(new RegExp(`node-(v${NODE_MAJOR}\\.\\d+\\.\\d+)-linux-x64\\.tar\\.gz`));
  if (!match) {
    throw new Error(`Could not resolve latest Node ${NODE_MAJOR}.x release`);
  }

  return match[1];
}

async function stageBundledNodeRuntime(targetRoot, target, nodeVersion) {
  const targetTempRoot = path.join(tempRoot, target.key);
  const nodePlatform = target.nodePlatform || target.platform;
  const isZipArchive = target.archiveExtension === 'zip';
  const archiveName = `node-${nodeVersion}-${nodePlatform}-${target.nodeArch}.${isZipArchive ? 'zip' : 'tar.gz'}`;
  const archivePath = path.join(targetTempRoot, archiveName);
  const downloadUrl = `https://nodejs.org/dist/${nodeVersion}/${archiveName}`;
  const extractRoot = path.join(targetTempRoot, 'extract');
  const extractedNodeRoot = path.join(extractRoot, `node-${nodeVersion}-${nodePlatform}-${target.nodeArch}`);

  ensureDir(targetTempRoot);
  if (!existsSync(archivePath)) {
    console.log(`Downloading ${downloadUrl}`);
    await downloadFile(downloadUrl, archivePath);
  }

  rmSync(extractRoot, { recursive: true, force: true });
  ensureDir(extractRoot);
  if (isZipArchive) {
    runCommand('powershell', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `Expand-Archive -LiteralPath ${JSON.stringify(archivePath)} -DestinationPath ${JSON.stringify(extractRoot)} -Force`,
    ]);
  } else {
    runCommand('tar', ['-xzf', archivePath, '-C', extractRoot]);
  }
  copyRequiredPath(extractedNodeRoot, path.join(targetRoot, 'node'));
}

function installRuntimeDependencies(targetRoot, target) {
  writeFileSync(
    path.join(targetRoot, 'package.json'),
    `${JSON.stringify(buildRuntimePackageJson(target), null, 2)}\n`,
    'utf8',
  );

  const env = buildChildEnv({
    npm_config_platform: target.platform,
    npm_config_arch: target.arch,
    npm_config_target_platform: target.platform,
    npm_config_target_arch: target.arch,
    npm_config_build_from_source: 'false',
    prebuild_install_platform: target.platform,
    prebuild_install_arch: target.arch,
  });

  runCommand('pnpm', ['install', '--prod', '--ignore-workspace', '--no-lockfile'], {
    cwd: targetRoot,
    env,
  });

  if (shouldBuildNativeDependenciesOnHost(target)) {
    runCommand('pnpm', ['rebuild', 'better-sqlite3', 'node-pty'], {
      cwd: targetRoot,
      env,
    });
  }
}

function writeLauncher(targetRoot, target) {
  if (target.platform === 'win32') {
    const powershellLauncherPath = path.join(targetRoot, 'bin', 'start-backend.ps1');
    const cmdLauncherPath = path.join(targetRoot, 'bin', 'start-backend.cmd');
    const powershellScript = [
      '$ErrorActionPreference = "Stop"',
      '$port = if ($args.Count -gt 0 -and $args[0]) { [int]$args[0] } else { 11111 }',
      '$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path',
      '$runtimeRoot = Split-Path -Parent $scriptDir',
      '$logRoot = Join-Path $HOME ".elevenex\\logs"',
      'New-Item -ItemType Directory -Force $logRoot | Out-Null',
      '$env:ELEVENEX_BACKEND_RUNTIME_ROOT = $runtimeRoot',
      '$env:DB_PATH = Join-Path $HOME ".elevenex\\elevenex.db"',
      '$env:ELEVENEX_PROXY_PORT = "$port"',
      '$env:FRONTEND_PORT = "$port"',
      '$node = Join-Path $runtimeRoot "node\\node.exe"',
      '$entry = Join-Path $runtimeRoot "main.cjs"',
      '$stdoutLog = Join-Path $logRoot "backend.log"',
      '$stderrLog = Join-Path $logRoot "backend.err.log"',
      '$pidPath = Join-Path $HOME ".elevenex\\backend.pid"',
      '$process = Start-Process -FilePath $node -ArgumentList @($entry) -WindowStyle Hidden -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog -PassThru',
      'Set-Content -LiteralPath $pidPath -Value $process.Id',
      'Wait-Process -Id $process.Id',
    ].join('\r\n');
    const cmdScript = '@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-backend.ps1" %*\r\n';
    ensureDir(path.dirname(powershellLauncherPath));
    writeFileSync(powershellLauncherPath, `${powershellScript}\r\n`, 'utf8');
    writeFileSync(cmdLauncherPath, cmdScript, 'utf8');
    return;
  }

  const launcherPath = path.join(targetRoot, 'bin', 'start-backend.sh');
  const script = [
    '#!/bin/sh',
    'set -eu',
    'PORT="${1:-11111}"',
    'SCRIPT_DIR="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"',
    'RUNTIME_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"',
    'mkdir -p "$HOME/.elevenex/logs"',
    'export ELEVENEX_BACKEND_RUNTIME_ROOT="$RUNTIME_ROOT"',
    'export DB_PATH="$HOME/.elevenex/elevenex.db"',
    'export ELEVENEX_PROXY_PORT="$PORT"',
    'export FRONTEND_PORT="$PORT"',
    'exec "$RUNTIME_ROOT/node/bin/node" "$RUNTIME_ROOT/main.cjs" >> "$HOME/.elevenex/logs/backend.log" 2>&1',
  ].join('\n');
  ensureDir(path.dirname(launcherPath));
  writeFileSync(launcherPath, `${script}\n`, 'utf8');
  chmodSync(launcherPath, 0o755);
}

function archiveTarget(targetRoot, target) {
  if (target.archiveExtension === 'zip') {
    const archivePath = path.join(remoteRuntimeRoot, `${target.key}.zip`);
    rmSync(archivePath, { force: true });
    runCommand('powershell', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `Compress-Archive -Path ${JSON.stringify(path.join(targetRoot, '*'))} -DestinationPath ${JSON.stringify(archivePath)} -Force`,
    ]);
    return;
  }

  const archivePath = path.join(remoteRuntimeRoot, `${target.key}.tar.gz`);
  runCommand('tar', ['-czf', archivePath, '-C', targetRoot, '.']);
}

async function stageTarget(target, commitSha, nodeVersion) {
  const targetRoot = path.join(remoteRuntimeRoot, target.key);
  ensureDir(targetRoot);

  copyRequiredPath(path.join(backendBundleRoot, 'main.cjs'), path.join(targetRoot, 'main.cjs'));
  copyRequiredPath(path.join(backendRoot, 'drizzle'), path.join(targetRoot, 'drizzle'));
  copyRequiredPath(path.join(backendRoot, 'bin'), path.join(targetRoot, 'bin'));
  copyRequiredPath(path.join(repoRoot, 'apps', 'frontend', 'proxy.conf.json'), path.join(targetRoot, 'proxy.conf.json'));
  copyRequiredPath(stagedVSCodeRoot, path.join(targetRoot, 'vscode-web-dist'));
  stageExtensionRuntime('vscode-filesystem-provider', targetRoot);
  stageExtensionRuntime('vscode-scm-extension', targetRoot);
  writeFileSync(path.join(targetRoot, 'version'), `${commitSha}\n`, 'utf8');
  writeFileSync(path.join(targetRoot, 'runtime-target'), `${target.key}\n`, 'utf8');

  await stageBundledNodeRuntime(targetRoot, target, nodeVersion);
  installRuntimeDependencies(targetRoot, target);
  writeLauncher(targetRoot, target);

  removeSourceMaps(targetRoot);
  removeGitArtifacts(targetRoot);
  restoreSpawnHelperPermissions(targetRoot);
  archiveTarget(targetRoot, target);
}

function parseCliArgs(argv) {
  const result = { target: null, skipReset: false };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--target=')) {
      result.target = arg.slice('--target='.length);
    } else if (arg === '--skip-reset') {
      result.skipReset = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: stage-remote-runtime.js [--target=<key>] [--skip-reset]');
      process.exit(0);
    }
  }
  return result;
}

async function main() {
  const cli = parseCliArgs(process.argv);
  const selectedTargets = cli.target
    ? TARGETS.filter((t) => t.key === cli.target)
    : TARGETS;

  if (cli.target && selectedTargets.length === 0) {
    throw new Error(`Unknown target "${cli.target}". Known: ${TARGETS.map((t) => t.key).join(', ')}`);
  }

  if (!cli.skipReset) {
    resetStageRoots();
  } else {
    ensureDir(remoteRuntimeRoot);
    ensureDir(tempRoot);
  }
  assembleRuntime();

  const commitSha = execSync('git rev-parse HEAD', { cwd: repoRoot }).toString().trim();
  const nodeVersion = await resolveLatestNodeVersion();

  for (const target of selectedTargets) {
    console.log(`Staging remote runtime for ${target.key}`);
    await stageTarget(target, commitSha, nodeVersion);
    console.log(`  ${target.key}: ${formatSize(getDirectorySize(path.join(remoteRuntimeRoot, target.key)))}`);
  }

  const manifestPath = path.join(remoteRuntimeRoot, 'manifest.json');
  const existingManifest = existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, 'utf8'))
    : { version: commitSha, nodeVersion, targets: [] };
  const targetEntries = new Map(
    (existingManifest.targets || []).map((entry) => [entry.key, entry]),
  );
  for (const target of selectedTargets) {
    const archiveExtension = target.archiveExtension || 'tar.gz';
    targetEntries.set(target.key, { key: target.key, archive: `${target.key}.${archiveExtension}` });
  }

  const manifest = {
    version: commitSha,
    nodeVersion,
    targets: [...targetEntries.values()],
  };

  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`Remote runtime staged at ${remoteRuntimeRoot}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
