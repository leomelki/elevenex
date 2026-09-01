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
const { REMOTE_HOME_DIRNAME } = require('../apps/electron/remote-server-utils.cjs');

const repoRoot = path.resolve(__dirname, '..');
const backendRoot = path.join(repoRoot, 'apps', 'backend');
const backendBundleRoot = path.join(backendRoot, 'bundle');
const stageBaseRoot = path.join(repoRoot, 'apps', 'electron', '.stage');
const remoteRuntimeRoot = path.join(stageBaseRoot, 'remote-runtime');
const tempRoot = path.join(stageBaseRoot, 'remote-runtime-tmp');
const backendPackageJson = require(path.join(backendRoot, 'package.json'));
const NODE_MAJOR = 22;
// Exit code the backend uses to ask its launcher for a restart (see
// apps/backend/src/runtime-control/runtime-control.service.ts). The launchers
// below supervise the process so Settings -> "Restart backend" works on a
// remote host, where quitting the desktop app cannot restart anything.
const BACKEND_RESTART_EXIT_CODE = 75;
const TARGETS = [
  { key: 'linux-x64', platform: 'linux', arch: 'x64', nodeArch: 'x64' },
  { key: 'linux-arm64', platform: 'linux', arch: 'arm64', nodeArch: 'arm64' },
  { key: 'darwin-x64', platform: 'darwin', arch: 'x64', nodeArch: 'x64' },
  { key: 'darwin-arm64', platform: 'darwin', arch: 'arm64', nodeArch: 'arm64' },
  { key: 'win32-x64', platform: 'win32', arch: 'x64', nodeArch: 'x64', nodePlatform: 'win', archiveExtension: 'zip' },
];
const NATIVE_RUNTIME_DEPENDENCIES = [
  'better-sqlite3',
  'node-pty',
  '@openai/codex-sdk',
  '@vscode/ripgrep',
  // main.cjs keeps this external and requires it when offline dictation runs.
  // Omitting it does not break the build — it breaks the first dictation on
  // every remote backend, which is far harder to notice.
  'onnxruntime-node',
];

/**
 * ONNX Runtime ships every platform's addon in one ~210 MB package. A remote
 * runtime is uploaded over SSH, so carrying five platforms' binaries to a
 * machine that can load one is the difference between a ~50 MB and a ~260 MB
 * transfer. Prune to the target being staged.
 */
const ONNXRUNTIME_BINDING_ROOT = ['node_modules', 'onnxruntime-node', 'bin', 'napi-v6'];

/** Targets ONNX Runtime publishes an addon for; see whisper-platform.ts. */
const ONNXRUNTIME_SUPPORTED_TARGETS = new Set([
  'darwin-arm64',
  'linux-arm64',
  'linux-x64',
  'win32-arm64',
  'win32-x64',
]);
const CODEX_CLI_PACKAGE_NAMES = [
  'codex',
  'codex-darwin-arm64',
  'codex-darwin-x64',
  'codex-linux-arm64',
  'codex-linux-x64',
  'codex-win32-arm64',
  'codex-win32-x64',
];

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

function prepareNodeGypShim() {
  const pnpmRoot = path.join(repoRoot, 'node_modules', '.pnpm');
  const nodeGypPackage = existsSync(pnpmRoot)
    ? readdirSync(pnpmRoot)
        .filter((entry) => entry.startsWith('node-gyp@'))
        .sort(
          (left, right) =>
            Number.parseInt(right.slice('node-gyp@'.length), 10) -
            Number.parseInt(left.slice('node-gyp@'.length), 10),
        )[0]
    : null;
  if (!nodeGypPackage) {
    throw new Error('Could not locate node-gyp required to build remote native modules');
  }

  const entrypoint = path.join(
    pnpmRoot,
    nodeGypPackage,
    'node_modules',
    'node-gyp',
    'bin',
    'node-gyp.js',
  );
  if (!existsSync(entrypoint)) {
    throw new Error(`node-gyp entrypoint is missing: ${entrypoint}`);
  }

  const shimRoot = path.join(tempRoot, 'tool-bin');
  ensureDir(shimRoot);
  if (process.platform === 'win32') {
    writeFileSync(
      path.join(shimRoot, 'node-gyp.cmd'),
      `@echo off\r\n"${process.execPath}" "${entrypoint}" %*\r\n`,
      'utf8',
    );
  } else {
    const shimPath = path.join(shimRoot, 'node-gyp');
    writeFileSync(
      shimPath,
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(entrypoint)} "$@"\n`,
      'utf8',
    );
    chmodSync(shimPath, 0o755);
  }
  return shimRoot;
}

function installRuntimeDependencies(targetRoot, target) {
  writeFileSync(
    path.join(targetRoot, 'package.json'),
    `${JSON.stringify(buildRuntimePackageJson(target), null, 2)}\n`,
    'utf8',
  );

  const nodeGypShimRoot = prepareNodeGypShim();
  const env = buildChildEnv({
    PATH: `${nodeGypShimRoot}${path.delimiter}${process.env.PATH || ''}`,
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

}

function validateRemoteNativeRuntime(targetRoot, target) {
  if (!shouldBuildNativeDependenciesOnHost(target)) return;
  const nodeExecutable =
    target.platform === 'win32'
      ? path.join(targetRoot, 'node', 'node.exe')
      : path.join(targetRoot, 'node', 'bin', 'node');
  const script = [
    "const path = require('path');",
    'const root = process.argv[1];',
    "const Database = require(path.join(root, 'node_modules', 'better-sqlite3'));",
    "const db = new Database(':memory:');",
    "db.prepare('select 1 as ok').get();",
    'db.close();',
    "require(path.join(root, 'node_modules', 'node-pty'));",
    // Only meaningful when the host is the target, which is what this whole
    // function is gated on. Catches a mispruned addon before it reaches a user.
    "require(path.join(root, 'node_modules', 'onnxruntime-node'));",
  ].join('');
  const result = spawnSync(nodeExecutable, ['-e', script, targetRoot], {
    cwd: targetRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      [
        `Remote native module smoke test failed for ${target.key}.`,
        result.stderr.trim(),
        result.stdout.trim(),
      ].filter(Boolean).join('\n'),
    );
  }
}

/**
 * Keeps only the target's own ONNX Runtime addon, and reports when the target
 * has none. `darwin-x64` is the live case: upstream stopped publishing an Intel
 * macOS build after 1.23.2, so that runtime ships without an engine and the
 * backend reports offline dictation as unavailable there.
 */
function pruneOnnxRuntimeBinaries(targetRoot, target) {
  const bindingRoot = path.join(targetRoot, ...ONNXRUNTIME_BINDING_ROOT);
  if (!existsSync(bindingRoot)) {
    console.warn(`  ${target.key}: onnxruntime-node binaries are missing; offline dictation will be unavailable`);
    return;
  }

  const keepDir = path.join(bindingRoot, target.platform, target.arch);
  for (const platformEntry of readdirSync(bindingRoot)) {
    const platformRoot = path.join(bindingRoot, platformEntry);
    if (!statSync(platformRoot).isDirectory()) continue;

    for (const archEntry of readdirSync(platformRoot)) {
      const archRoot = path.join(platformRoot, archEntry);
      if (path.resolve(archRoot) !== path.resolve(keepDir)) {
        rmSync(archRoot, { recursive: true, force: true });
      }
    }

    if (readdirSync(platformRoot).length === 0) {
      rmSync(platformRoot, { recursive: true, force: true });
    }
  }

  if (!existsSync(keepDir)) {
    if (ONNXRUNTIME_SUPPORTED_TARGETS.has(target.key)) {
      throw new Error(
        `onnxruntime-node has no addon for ${target.key}; offline dictation would fail at runtime on this target.`,
      );
    }
    console.warn(
      `  ${target.key}: onnxruntime-node publishes no addon for this target; offline dictation will report itself unavailable`,
    );
  }
}

function removeEmbeddedAgentExecutables(targetRoot) {
  const nodeModulesRoot = path.join(targetRoot, 'node_modules');
  const pnpmRoot = path.join(nodeModulesRoot, '.pnpm');

  // Keep the JavaScript SDKs used by the backend, but remove their optional
  // CLI packages. Agent executables are managed by the user on the remote
  // PATH so runtime/model updates do not depend on an Elevenex release.
  const openAiScope = path.join(nodeModulesRoot, '@openai');
  for (const packageName of CODEX_CLI_PACKAGE_NAMES) {
    rmSync(path.join(openAiScope, packageName), { recursive: true, force: true });
  }

  const anthropicScope = path.join(nodeModulesRoot, '@anthropic-ai');
  if (existsSync(anthropicScope)) {
    for (const packageName of readdirSync(anthropicScope)) {
      if (packageName.startsWith('claude-agent-sdk-')) {
        rmSync(path.join(anthropicScope, packageName), {
          recursive: true,
          force: true,
        });
      }
    }
  }

  if (existsSync(pnpmRoot)) {
    for (const entry of readdirSync(pnpmRoot)) {
      if (
        entry.startsWith('@openai+codex@') ||
        entry.startsWith('@anthropic-ai+claude-agent-sdk-')
      ) {
        rmSync(path.join(pnpmRoot, entry), { recursive: true, force: true });
      } else if (entry.startsWith('@openai+codex-sdk@')) {
        for (const relativePath of [
          ['node_modules', '@openai', 'codex'],
          [
            'node_modules',
            '@openai',
            'codex-sdk',
            'node_modules',
            '.bin',
            'codex',
          ],
        ]) {
          rmSync(path.join(pnpmRoot, entry, ...relativePath), {
            recursive: true,
            force: true,
          });
        }
      } else if (entry.startsWith('@anthropic-ai+claude-agent-sdk@')) {
        rmSync(
          path.join(
            pnpmRoot,
            entry,
            'node_modules',
            '@anthropic-ai',
            'claude-agent-sdk',
            'node_modules',
            '.bin',
            'claude',
          ),
          { recursive: true, force: true },
        );
      }
    }

    for (const shimPath of [
      path.join(nodeModulesRoot, '.bin', 'codex'),
      path.join(nodeModulesRoot, '.bin', 'claude'),
      path.join(pnpmRoot, 'node_modules', '.bin', 'codex'),
      path.join(pnpmRoot, 'node_modules', '.bin', 'claude'),
    ]) {
      rmSync(shimPath, { recursive: true, force: true });
    }

    const pnpmOpenAiScope = path.join(pnpmRoot, 'node_modules', '@openai');
    if (existsSync(pnpmOpenAiScope)) {
      for (const packageName of readdirSync(pnpmOpenAiScope)) {
        if (packageName === 'codex' || packageName.startsWith('codex-')) {
          rmSync(path.join(pnpmOpenAiScope, packageName), {
            recursive: true,
            force: true,
          });
        }
      }
    }
  }

  const leftovers = [
    path.join(nodeModulesRoot, '.bin', 'codex'),
    path.join(nodeModulesRoot, '.bin', 'claude'),
    path.join(pnpmRoot, 'node_modules', '.bin', 'codex'),
    path.join(pnpmRoot, 'node_modules', '.bin', 'claude'),
    ...CODEX_CLI_PACKAGE_NAMES.map((packageName) =>
      path.join(openAiScope, packageName),
    ),
    ...(existsSync(anthropicScope)
      ? readdirSync(anthropicScope)
          .filter((packageName) => packageName.startsWith('claude-agent-sdk-'))
          .map((packageName) => path.join(anthropicScope, packageName))
      : []),
    ...(existsSync(pnpmRoot)
      ? readdirSync(pnpmRoot)
          .filter(
            (entry) =>
              entry.startsWith('@openai+codex@') ||
              entry.startsWith('@anthropic-ai+claude-agent-sdk-'),
          )
          .map((entry) => path.join(pnpmRoot, entry))
      : []),
    ...(existsSync(pnpmRoot)
      ? readdirSync(pnpmRoot)
          .filter((entry) => entry.startsWith('@openai+codex-sdk@'))
          .map((entry) =>
            path.join(
              pnpmRoot,
              entry,
              'node_modules',
              '@openai',
              'codex-sdk',
              'node_modules',
              '.bin',
              'codex',
            ),
          )
      : []),
    ...(existsSync(pnpmRoot)
      ? readdirSync(pnpmRoot)
          .filter((entry) =>
            entry.startsWith('@anthropic-ai+claude-agent-sdk@'),
          )
          .map((entry) =>
            path.join(
              pnpmRoot,
              entry,
              'node_modules',
              '@anthropic-ai',
              'claude-agent-sdk',
              'node_modules',
              '.bin',
              'claude',
            ),
          )
      : []),
  ].filter((candidate) => existsSync(candidate));

  if (leftovers.length) {
    throw new Error(
      `Refusing to package embedded agent executables: ${leftovers.join(', ')}`,
    );
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
      `$logRoot = Join-Path $HOME "${REMOTE_HOME_DIRNAME}\\logs"`,
      'New-Item -ItemType Directory -Force $logRoot | Out-Null',
      '$env:ELEVENEX_BACKEND_RUNTIME_ROOT = $runtimeRoot',
      `$env:DB_PATH = Join-Path $HOME "${REMOTE_HOME_DIRNAME}\\elevenex.db"`,
      // Whisper weights run to a gigabyte; keep them with the rest of this
      // runtime's state so removing the remote install takes them too.
      `$env:ELEVENEX_WHISPER_CACHE_DIR = Join-Path $HOME "${REMOTE_HOME_DIRNAME}\\whisper-models"`,
      '$env:ELEVENEX_PROXY_PORT = "$port"',
      '$env:FRONTEND_PORT = "$port"',
      '$node = Join-Path $runtimeRoot "node\\node.exe"',
      '$entry = Join-Path $runtimeRoot "main.cjs"',
      '$stdoutLog = Join-Path $logRoot "backend.log"',
      '$stderrLog = Join-Path $logRoot "backend.err.log"',
      // Must match the pid file the start/preflight scripts read, otherwise a
      // stale backend is never detected or cleaned up before a restart.
      `$pidPath = Join-Path $HOME "${REMOTE_HOME_DIRNAME}\\backend.pid"`,
      '$env:ELEVENEX_BACKEND_SUPERVISED = "1"',
      // Loop instead of a single Wait-Process so a restart requested from the
      // app comes back on the same port, with the pid file kept current for the
      // preflight that decides whether a fresh start is needed.
      'while ($true) {',
      '  $process = Start-Process -FilePath $node -ArgumentList @($entry) -WindowStyle Hidden -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog -PassThru',
      '  Set-Content -LiteralPath $pidPath -Value $process.Id',
      '  $process.WaitForExit()',
      `  if ($process.ExitCode -ne ${BACKEND_RESTART_EXIT_CODE}) { exit $process.ExitCode }`,
      '}',
    ].join('\r\n');
    const cmdScript = '@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-backend.ps1" %*\r\n';
    ensureDir(path.dirname(powershellLauncherPath));
    writeFileSync(powershellLauncherPath, `${powershellScript}\r\n`, 'utf8');
    writeFileSync(cmdLauncherPath, cmdScript, 'utf8');
    return;
  }

  // Backend output must land in the remote runtime's own log tree: that is the
  // file the start/wait scripts write their progress banners to and tail when
  // startup fails. Logging anywhere else leaves a failed launch reported as a
  // bare connection refusal with no diagnostics attached.
  const launcherPath = path.join(targetRoot, 'bin', 'start-backend.sh');
  const script = [
    '#!/bin/sh',
    'set -eu',
    'PORT="${1:-11111}"',
    'SCRIPT_DIR="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"',
    'RUNTIME_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"',
    `mkdir -p "$HOME/${REMOTE_HOME_DIRNAME}/logs"`,
    'export ELEVENEX_BACKEND_RUNTIME_ROOT="$RUNTIME_ROOT"',
    `export DB_PATH="$HOME/${REMOTE_HOME_DIRNAME}/elevenex.db"`,
    // Whisper weights run to a gigabyte; keep them with the rest of this
    // runtime's state so removing the remote install takes them too.
    `export ELEVENEX_WHISPER_CACHE_DIR="$HOME/${REMOTE_HOME_DIRNAME}/whisper-models"`,
    'export ELEVENEX_PROXY_PORT="$PORT"',
    'export FRONTEND_PORT="$PORT"',
    'export ELEVENEX_BACKEND_SUPERVISED=1',
    `LOG_FILE="$HOME/${REMOTE_HOME_DIRNAME}/logs/backend.log"`,
    // Supervise rather than exec: a restart requested from the app must come
    // back inside this same tmux session, otherwise the next connect's
    // `tmux kill-session` would leave an untracked backend holding the port.
    'while :; do',
    '  STATUS=0',
    '  "$RUNTIME_ROOT/node/bin/node" "$RUNTIME_ROOT/main.cjs" >> "$LOG_FILE" 2>&1 || STATUS=$?',
    `  if [ "$STATUS" -ne ${BACKEND_RESTART_EXIT_CODE} ]; then exit "$STATUS"; fi`,
    '  printf "\\n[%s] Restarting Elevenex backend on request\\n" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$LOG_FILE"',
    'done',
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
  pruneOnnxRuntimeBinaries(targetRoot, target);
  removeEmbeddedAgentExecutables(targetRoot);
  validateRemoteNativeRuntime(targetRoot, target);
  copyRequiredPath(
    path.join(
      backendRoot,
      'node_modules',
      '@anthropic-ai',
      'claude-agent-sdk',
      'package.json',
    ),
    path.join(
      targetRoot,
      'node_modules',
      '@anthropic-ai',
      'claude-agent-sdk',
      'package.json',
    ),
  );
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

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : error);
    process.exitCode = 1;
  });
}

module.exports = { removeEmbeddedAgentExecutables, pruneOnnxRuntimeBinaries };
