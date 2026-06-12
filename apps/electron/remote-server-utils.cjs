// Home-relative directory the remote runtime is installed into. Kept separate
// from the local/embedded runtime's `.elevenex` so a remote backend reached over
// SSH-to-localhost never shares a tree (runtime, logs, pid, DB) with the local
// embedded backend. Single source of truth for every generated remote script.
const REMOTE_HOME_DIRNAME = '.elevenex-remote';

const REMOTE_RUNTIME_TARGETS = Object.freeze({
  'linux-x64': {
    platform: 'linux',
    arch: 'x64',
    unameArchValues: ['x86_64', 'amd64'],
  },
  'linux-arm64': {
    platform: 'linux',
    arch: 'arm64',
    unameArchValues: ['aarch64', 'arm64'],
  },
  'darwin-x64': {
    platform: 'darwin',
    arch: 'x64',
    unameArchValues: ['x86_64', 'amd64'],
  },
  'darwin-arm64': {
    platform: 'darwin',
    arch: 'arm64',
    unameArchValues: ['arm64'],
  },
  'win32-x64': {
    platform: 'win32',
    arch: 'x64',
    unameArchValues: ['x64', 'amd64'],
    archiveExtension: 'zip',
  },
});

const REMOTE_INSTALL_PHASES = Object.freeze([
  'checking',
  'missing-prereqs',
  'uploading',
  'installing',
  'starting',
  'probing',
  'ready',
]);

function shellSingleQuote(value) {
  return `'${`${value}`.replace(/'/g, `'\\''`)}'`;
}

function shellPathQuote(value) {
  const raw = `${value}`;
  const escape = (segment) => segment.replace(/(["\\`$])/g, '\\$1');
  if (raw.startsWith('~/')) {
    return `"$HOME/${escape(raw.slice(2))}"`;
  }
  if (raw === '~') {
    return '"$HOME"';
  }
  return `"${escape(raw)}"`;
}

function powershellSingleQuote(value) {
  return `'${`${value}`.replace(/'/g, "''")}'`;
}

function powershellPathExpression(value) {
  const raw = `${value}`;
  if (raw === '~') {
    return '$HOME';
  }
  if (raw.startsWith('~/') || raw.startsWith('~\\')) {
    return `(Join-Path $HOME ${powershellSingleQuote(raw.slice(2).replace(/\//g, '\\'))})`;
  }
  return powershellSingleQuote(raw.replace(/\//g, '\\'));
}

function decodeOsReleaseValue(value) {
  const trimmed = `${value || ''}`.trim();
  if (!trimmed) {
    return '';
  }

  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith('\'') && trimmed.endsWith('\''))
  ) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

function parseOsRelease(raw) {
  const values = {};
  for (const line of `${raw || ''}`.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1);
    values[key] = decodeOsReleaseValue(value);
  }

  return values;
}

function normalizeRemotePlatform(unameValue) {
  const normalized = `${unameValue || ''}`.trim().toLowerCase();
  if (normalized === 'linux') {
    return 'linux';
  }

  if (normalized === 'darwin') {
    return 'darwin';
  }

  if (normalized === 'freebsd') {
    return 'freebsd';
  }

  if (
    normalized === 'windows'
    || normalized === 'win32'
    || normalized === 'windows_nt'
    || normalized.startsWith('mingw')
    || normalized.startsWith('msys')
    || normalized.startsWith('cygwin')
  ) {
    return 'win32';
  }

  return normalized || 'unknown';
}

function normalizeRemoteArch(unameValue) {
  const normalized = `${unameValue || ''}`.trim().toLowerCase();

  if (['x86_64', 'amd64', 'x64'].includes(normalized)) {
    return 'x64';
  }

  if (['aarch64', 'arm64'].includes(normalized)) {
    return 'arm64';
  }

  return normalized || 'unknown';
}

function resolveRemoteRuntimeTarget(platform, arch) {
  const normalizedPlatform = normalizeRemotePlatform(platform);
  const normalizedArch = normalizeRemoteArch(arch);
  const key = `${normalizedPlatform}-${normalizedArch}`;
  return REMOTE_RUNTIME_TARGETS[key] ? key : null;
}

function parseRemotePreflight(raw) {
  const data = {};
  for (const line of `${raw || ''}`.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex);
    const value = trimmed.slice(separatorIndex + 1);
    data[key] = value;
  }

  const remotePlatform = normalizeRemotePlatform(data.uname_s);
  const remoteArch = normalizeRemoteArch(data.uname_m);
  const remoteTarget = resolveRemoteRuntimeTarget(remotePlatform, remoteArch);
  const osRelease = parseOsRelease(`${data.os_release_raw || ''}`.replace(/\t/g, '\n'));
  const missingDependencies = [];

  if (data.has_claude !== '1') {
    missingDependencies.push('claude');
  }

  if (remotePlatform !== 'win32' && data.has_tmux !== '1') {
    missingDependencies.push('tmux');
  }

  return {
    remotePlatform,
    remoteArch,
    remoteTarget,
    osRelease,
    hasClaude: data.has_claude === '1',
    hasTmux: data.has_tmux === '1',
    currentVersion: `${data.current_version || ''}`.trim(),
    runningBackendVersion: `${data.running_backend_version || ''}`.trim(),
    tmuxSessionPresent: data.tmux_session_present === '1',
    backendReachable: data.backend_reachable === '1',
    missingDependencies,
  };
}

function buildWindowsRemotePreflightScript(remotePort) {
  const safePort = Number(remotePort);
  const port = Number.isFinite(safePort) ? safePort : 11111;
  const probeProjectsScript = `const http=require('http');const req=http.get({host:'127.0.0.1',port:${port},path:'/api/projects',timeout:1200},(res)=>{process.exit(res.statusCode&&res.statusCode<500?0:1)});req.on('timeout',()=>req.destroy(new Error('timeout')));req.on('error',()=>process.exit(1));`;
  const probeInfoScript = `const http=require('http');const req=http.get({host:'127.0.0.1',port:${port},path:'/api/info',timeout:1200},(res)=>{let body='';res.setEncoding('utf8');res.on('data',(chunk)=>body+=chunk);res.on('end',()=>{try{const data=JSON.parse(body);process.stdout.write(typeof data.backendSha==='string'?data.backendSha:'')}catch{process.exit(1)}})});req.on('timeout',()=>req.destroy(new Error('timeout')));req.on('error',()=>process.exit(1));`;
  return [
    '$ErrorActionPreference = "Stop"',
    `$root = Join-Path $HOME "${REMOTE_HOME_DIRNAME}"`,
    '$logRoot = Join-Path $root "logs"',
    'New-Item -ItemType Directory -Force -Path $logRoot | Out-Null',
    '$installLog = Join-Path $logRoot "install.log"',
    'function Log([string]$Message) { "$((Get-Date).ToUniversalTime().ToString("o")) $Message" | Add-Content -LiteralPath $installLog }',
    `Log "preflight: checking remote runtime on port ${port}"`,
    '$arch = $env:PROCESSOR_ARCHITECTURE',
    'if (-not $arch) { $arch = "unknown" }',
    '$hasClaude = if (Get-Command claude -ErrorAction SilentlyContinue) { "1" } else { "0" }',
    '$hasTmux = "1"',
    '$currentVersion = ""',
    '$currentVersionPath = Join-Path $root "current\\version"',
    'if (Test-Path -LiteralPath $currentVersionPath) { $currentVersion = (Get-Content -LiteralPath $currentVersionPath -Raw).Trim() }',
    '$pidPath = Join-Path $root "backend.pid"',
    '$tmuxSessionPresent = "0"',
    'if (Test-Path -LiteralPath $pidPath) {',
    '  $oldPidText = (Get-Content -LiteralPath $pidPath -Raw).Trim()',
    '  $oldPid = 0',
    '  if ([int]::TryParse($oldPidText, [ref]$oldPid) -and (Get-Process -Id $oldPid -ErrorAction SilentlyContinue)) { $tmuxSessionPresent = "1" }',
    '}',
    '$backendReachable = "0"',
    '$runningBackendVersion = ""',
    '$node = Join-Path $root "current\\node\\node.exe"',
    'if (Test-Path -LiteralPath $node) {',
    `  & $node -e ${powershellSingleQuote(probeProjectsScript)} *> $null; if ($LASTEXITCODE -eq 0) { $backendReachable = "1" }`,
    `  $runningBackendVersion = (& $node -e ${powershellSingleQuote(probeInfoScript)} 2>$null) -join ""`,
    '}',
    '$caption = "Windows"',
    'try { $caption = (Get-CimInstance Win32_OperatingSystem -ErrorAction Stop).Caption } catch {}',
    'Write-Output "uname_s=windows"',
    'Write-Output "uname_m=$arch"',
    'Write-Output "has_claude=$hasClaude"',
    'Write-Output "has_tmux=$hasTmux"',
    'Write-Output "current_version=$currentVersion"',
    'Write-Output "running_backend_version=$runningBackendVersion"',
    'Write-Output "tmux_session_present=$tmuxSessionPresent"',
    'Write-Output "backend_reachable=$backendReachable"',
    'Write-Output "os_release_raw=ID=windows`tPRETTY_NAME=$caption"',
    `Log "preflight: current=$currentVersion running=$runningBackendVersion reachable=$backendReachable target=windows/$arch"`,
  ].join('\r\n');
}

function buildRemotePreflightScript(remotePort) {
  const safePort = Number(remotePort);
  return [
    'set -eu',
    `mkdir -p "$HOME/${REMOTE_HOME_DIRNAME}/logs"`,
    `INSTALL_LOG="$HOME/${REMOTE_HOME_DIRNAME}/logs/install.log"`,
    'log() { printf "%s %s\\n" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$INSTALL_LOG"; }',
    `log "preflight: checking remote runtime on port ${Number.isFinite(safePort) ? safePort : 11111}"`,
    'UNAME_S="$(uname -s 2>/dev/null || printf unknown)"',
    'UNAME_M="$(uname -m 2>/dev/null || printf unknown)"',
    'OS_RELEASE_RAW=""',
    'if [ -r /etc/os-release ]; then',
    '  OS_RELEASE_RAW="$(cat /etc/os-release)"',
    'fi',
    'if command -v claude >/dev/null 2>&1; then HAS_CLAUDE=1; else HAS_CLAUDE=0; fi',
    'if command -v tmux >/dev/null 2>&1; then HAS_TMUX=1; else HAS_TMUX=0; fi',
    'CURRENT_VERSION=""',
    `if [ -r "$HOME/${REMOTE_HOME_DIRNAME}/current/version" ]; then`,
    `  CURRENT_VERSION="$(tr -d '\\r\\n' < "$HOME/${REMOTE_HOME_DIRNAME}/current/version")"`,
    'fi',
    'TMUX_PRESENT=0',
    'if [ "$HAS_TMUX" = "1" ] && tmux has-session -t elevenex-backend 2>/dev/null; then',
    '  TMUX_PRESENT=1',
    'fi',
    'BACKEND_REACHABLE=0',
    'RUNNING_BACKEND_VERSION=""',
    `if [ -x "$HOME/${REMOTE_HOME_DIRNAME}/current/node/bin/node" ]; then`,
    `  if "$HOME/${REMOTE_HOME_DIRNAME}/current/node/bin/node" -e "const http=require('http');const req=http.get({host:'127.0.0.1',port:${Number.isFinite(safePort) ? safePort : 11111},path:'/api/projects',timeout:1200},(res)=>{process.exit(res.statusCode&&res.statusCode<500?0:1)});req.on('timeout',()=>req.destroy(new Error('timeout')));req.on('error',()=>process.exit(1));" >/dev/null 2>&1; then`,
    '    BACKEND_REACHABLE=1',
    '  fi',
    `  RUNNING_BACKEND_VERSION="$("$HOME/${REMOTE_HOME_DIRNAME}/current/node/bin/node" -e "const http=require('http');const req=http.get({host:'127.0.0.1',port:${Number.isFinite(safePort) ? safePort : 11111},path:'/api/info',timeout:1200},(res)=>{let body='';res.setEncoding('utf8');res.on('data',(chunk)=>body+=chunk);res.on('end',()=>{try{const data=JSON.parse(body);process.stdout.write(typeof data.backendSha==='string'?data.backendSha:'')}catch{process.exit(1)}})});req.on('timeout',()=>req.destroy(new Error('timeout')));req.on('error',()=>process.exit(1));" 2>/dev/null || true)"`,
    'fi',
    'printf "uname_s=%s\\n" "$UNAME_S"',
    'printf "uname_m=%s\\n" "$UNAME_M"',
    'printf "has_claude=%s\\n" "$HAS_CLAUDE"',
    'printf "has_tmux=%s\\n" "$HAS_TMUX"',
    'printf "current_version=%s\\n" "$CURRENT_VERSION"',
    'printf "running_backend_version=%s\\n" "$RUNNING_BACKEND_VERSION"',
    'printf "tmux_session_present=%s\\n" "$TMUX_PRESENT"',
    'printf "backend_reachable=%s\\n" "$BACKEND_REACHABLE"',
    'printf "os_release_raw=%s\\n" "$(printf %s "$OS_RELEASE_RAW" | tr \'\\n\' \'\\t\')"',
    'log "preflight: current=$CURRENT_VERSION running=$RUNNING_BACKEND_VERSION reachable=$BACKEND_REACHABLE tmux=$TMUX_PRESENT target=$UNAME_S/$UNAME_M"',
  ].join('\n');
}

function buildWindowsRemoteInstallCommand({ remoteArchivePath, remoteReleaseDir, remoteCurrentLink }) {
  return [
    '$ErrorActionPreference = "Stop"',
    `$archivePath = ${powershellPathExpression(remoteArchivePath)}`,
    `$releaseDir = ${powershellPathExpression(remoteReleaseDir)}`,
    `$currentLink = ${powershellPathExpression(remoteCurrentLink)}`,
    `$root = Join-Path $HOME "${REMOTE_HOME_DIRNAME}"`,
    '$releasesRoot = Join-Path $root "releases"',
    '$tmpRoot = Join-Path $root "tmp"',
    '$logRoot = Join-Path $root "logs"',
    'New-Item -ItemType Directory -Force -Path $releasesRoot, $tmpRoot, $logRoot | Out-Null',
    '$installLog = Join-Path $logRoot "install.log"',
    'function Log([string]$Message) { "$((Get-Date).ToUniversalTime().ToString("o")) $Message" | Add-Content -LiteralPath $installLog }',
    `Log "install: extracting ${remoteArchivePath} to ${remoteReleaseDir}"`,
    'if (Test-Path -LiteralPath $releaseDir) { Remove-Item -LiteralPath $releaseDir -Recurse -Force }',
    'New-Item -ItemType Directory -Force -Path $releaseDir | Out-Null',
    'Expand-Archive -LiteralPath $archivePath -DestinationPath $releaseDir -Force',
    'if (Test-Path -LiteralPath $currentLink) {',
    '  $currentItem = Get-Item -LiteralPath $currentLink -Force',
    '  if (($currentItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {',
    '    cmd.exe /d /c rmdir "$currentLink" | Out-Null',
    '  } else {',
    '    Remove-Item -LiteralPath $currentLink -Recurse -Force',
    '  }',
    '}',
    'try {',
    '  New-Item -ItemType Junction -Path $currentLink -Target $releaseDir | Out-Null',
    '} catch {',
    '  cmd.exe /d /c mklink /J "$currentLink" "$releaseDir" | Out-Null',
    '}',
    'Remove-Item -LiteralPath $archivePath -Force',
    'Get-ChildItem -LiteralPath $releasesRoot -Directory | Sort-Object LastWriteTime -Descending | Select-Object -Skip 2 | Remove-Item -Recurse -Force',
    'Log "install: complete"',
  ].join('\r\n');
}

function buildRemoteInstallCommand({ remoteArchivePath, remoteReleaseDir, remoteCurrentLink }) {
  const releaseDir = shellPathQuote(remoteReleaseDir);
  return [
    'set -eu',
    `mkdir -p "$HOME/${REMOTE_HOME_DIRNAME}/releases" "$HOME/${REMOTE_HOME_DIRNAME}/tmp" "$HOME/${REMOTE_HOME_DIRNAME}/logs"`,
    `INSTALL_LOG="$HOME/${REMOTE_HOME_DIRNAME}/logs/install.log"`,
    'log() { printf "%s %s\\n" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$INSTALL_LOG"; }',
    `log "install: extracting ${remoteArchivePath} to ${remoteReleaseDir}"`,
    `rm -rf ${releaseDir}`,
    `mkdir -p ${releaseDir}`,
    `tar -xzf ${shellPathQuote(remoteArchivePath)} -C ${releaseDir}`,
    `RELEASE_DIR=${releaseDir}`,
    'PTY_DIR="$(find "$RELEASE_DIR/node_modules/.pnpm" -maxdepth 4 -type d -path "*/node-pty@*/node_modules/node-pty" 2>/dev/null | head -n 1 || true)"',
    'if [ -n "$PTY_DIR" ] && [ ! -f "$PTY_DIR/build/Release/pty.node" ]; then',
    '  PLATFORM_KEY="$(uname -s 2>/dev/null | tr \'[:upper:]\' \'[:lower:]\')"',
    '  ARCH_KEY="$(uname -m)"',
    '  case "$ARCH_KEY" in x86_64|amd64) ARCH_KEY=x64 ;; aarch64) ARCH_KEY=arm64 ;; esac',
    '  if [ ! -f "$PTY_DIR/prebuilds/$PLATFORM_KEY-$ARCH_KEY/pty.node" ]; then',
    '    if ! { command -v cc >/dev/null 2>&1 || command -v gcc >/dev/null 2>&1; } || ! command -v make >/dev/null 2>&1 || ! command -v python3 >/dev/null 2>&1; then',
    '      echo "Cannot compile node-pty on remote: missing build tools. Install cc/gcc, make, and python3, then retry." >&2',
    '      exit 1',
    '    fi',
    '    ( cd "$PTY_DIR" && PATH="$RELEASE_DIR/node/bin:$PATH" "$RELEASE_DIR/node/bin/npm" rebuild --build-from-source --foreground-scripts ) || {',
    '      echo "Failed to compile node-pty on the remote host." >&2',
    '      exit 1',
    '    }',
    '  fi',
    'fi',
    `ln -sfn ${releaseDir} ${shellPathQuote(remoteCurrentLink)}`,
    `rm -f ${shellPathQuote(remoteArchivePath)}`,
    'log "install: current symlink updated to $RELEASE_DIR"',
    `if [ -d "$HOME/${REMOTE_HOME_DIRNAME}/releases" ]; then`,
    `  ls -1dt "$HOME/${REMOTE_HOME_DIRNAME}/releases"/* 2>/dev/null | tail -n +3 | xargs rm -rf -- 2>/dev/null || true`,
    'fi',
    'log "install: complete"',
  ].join('\n');
}

function buildWindowsRemoteStartCommand({ remoteRoot, remotePort, forcePortCleanup }) {
  const safePort = Number.isFinite(Number(remotePort)) ? Number(remotePort) : 11111;
  return [
    '$ErrorActionPreference = "Stop"',
    `$port = ${safePort}`,
    `$forcePortCleanup = ${forcePortCleanup ? '$true' : '$false'}`,
    `$remoteRoot = ${powershellPathExpression(remoteRoot)}`,
    `$root = Join-Path $HOME "${REMOTE_HOME_DIRNAME}"`,
    '$logRoot = Join-Path $root "logs"',
    'New-Item -ItemType Directory -Force -Path $logRoot | Out-Null',
    '$installLog = Join-Path $logRoot "install.log"',
    'function Log([string]$Message) { "$((Get-Date).ToUniversalTime().ToString("o")) $Message" | Add-Content -LiteralPath $installLog }',
    'Log "start: requested for $remoteRoot on port $port force_cleanup=$forcePortCleanup"',
    '$pidPath = Join-Path $root "backend.pid"',
    'if (Test-Path -LiteralPath $pidPath) {',
    '  $oldPidText = (Get-Content -LiteralPath $pidPath -Raw).Trim()',
    '  $oldPid = 0',
    '  if ([int]::TryParse($oldPidText, [ref]$oldPid)) { Stop-Process -Id $oldPid -Force -ErrorAction SilentlyContinue }',
    '  Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue',
    '}',
    'if ($forcePortCleanup) {',
    '  try {',
    '    Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop |',
    '      Select-Object -ExpandProperty OwningProcess -Unique |',
    '      ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }',
    '  } catch { Log "start: no process cleanup performed for port $port" }',
    '}',
    '$launcher = Join-Path $remoteRoot "bin\\start-backend.ps1"',
    'if (-not (Test-Path -LiteralPath $launcher)) { throw "Missing Windows backend launcher: $launcher" }',
    '$process = Start-Process -FilePath "powershell.exe" -ArgumentList @("-NoProfile","-ExecutionPolicy","Bypass","-File",$launcher,"$port") -WindowStyle Hidden -PassThru',
    'Start-Sleep -Seconds 2',
    'if ($process.HasExited) {',
    '  Log "start: backend launcher exited quickly with code $($process.ExitCode)"',
    '  $backendLog = Join-Path $logRoot "backend.log"',
    '  if (Test-Path -LiteralPath $backendLog) { Get-Content -LiteralPath $backendLog -Tail 80 | Write-Error }',
    '  throw "Elevenex backend exited during startup."',
    '}',
    'Log "start: backend launcher is running"',
  ].join('\r\n');
}

function buildRemoteStartCommand({ remoteRoot, remotePort, forcePortCleanup }) {
  const safePort = Number.isFinite(Number(remotePort)) ? Number(remotePort) : 11111;
  return [
    'set -eu',
    `PORT=${safePort}`,
    `FORCE_PORT_CLEANUP=${forcePortCleanup ? '1' : '0'}`,
    `REMOTE_ROOT=${shellPathQuote(remoteRoot)}`,
    `INSTALL_LOG="$HOME/${REMOTE_HOME_DIRNAME}/logs/install.log"`,
    'log() { printf "%s %s\\n" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$INSTALL_LOG"; }',
    'if ! command -v tmux >/dev/null 2>&1; then',
    '  echo "tmux is required to start the Elevenex backend" >&2',
    '  exit 1',
    'fi',
    `mkdir -p "$HOME/${REMOTE_HOME_DIRNAME}/logs"`,
    'log "start: requested for $REMOTE_ROOT on port $PORT force_cleanup=$FORCE_PORT_CLEANUP"',
    'tmux kill-session -t elevenex-backend 2>/dev/null || true',
    'sleep 1',
    'if [ "$FORCE_PORT_CLEANUP" = "1" ]; then',
    '  if command -v fuser >/dev/null 2>&1; then',
    '    if fuser "$PORT/tcp" >/dev/null 2>&1; then',
    '      log "start: killing existing process on port $PORT with fuser"',
    '      fuser -k "$PORT/tcp" >> "$INSTALL_LOG" 2>&1 || true',
    '      sleep 1',
    '    fi',
    '  elif command -v lsof >/dev/null 2>&1; then',
    '    PIDS="$(lsof -ti tcp:"$PORT" 2>/dev/null || true)"',
    '    if [ -n "$PIDS" ]; then',
    '      log "start: killing existing process on port $PORT with lsof: $PIDS"',
    '      kill $PIDS >> "$INSTALL_LOG" 2>&1 || true',
    '      sleep 1',
    '    fi',
    '  else',
    '    log "start: no fuser/lsof available for port cleanup"',
    '  fi',
    'fi',
    `printf "\\n[%s] Starting Elevenex backend from %s on port %s\\n" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$REMOTE_ROOT" "$PORT" >> "$HOME/${REMOTE_HOME_DIRNAME}/logs/backend.log"`,
    'tmux new-session -d -s elevenex-backend "$REMOTE_ROOT/bin/start-backend.sh $PORT"',
    'sleep 1',
    'if tmux has-session -t elevenex-backend 2>/dev/null; then',
    '  log "start: tmux session is running"',
    'else',
    '  log "start: tmux session exited quickly"',
    `  echo "--- ~/${REMOTE_HOME_DIRNAME}/logs/backend.log (last 80 lines) ---" >&2`,
    `  tail -n 80 "$HOME/${REMOTE_HOME_DIRNAME}/logs/backend.log" >&2 || true`,
    '  exit 1',
    'fi',
  ].join('\n');
}

function buildWindowsRemoteWaitForReadyCommand({ remoteRoot, remotePort, expectedVersion }) {
  const safePort = Number.isFinite(Number(remotePort)) ? Number(remotePort) : 11111;
  const readinessProbeScript = [
    `const expected = ${JSON.stringify(`${expectedVersion || ''}`)};`,
    'const http = require("http");',
    `const req = http.get({ host: "127.0.0.1", port: ${safePort}, path: "/api/info", timeout: 1200 }, (res) => {`,
    'let body = "";',
    'res.setEncoding("utf8");',
    'res.on("data", (chunk) => body += chunk);',
    'res.on("end", () => {',
    'try {',
    'const data = JSON.parse(body);',
    'const sha = typeof data.backendSha === "string" ? data.backendSha : "";',
    'process.stdout.write("status=" + res.statusCode + " sha=" + sha);',
    'process.exit(res.statusCode && res.statusCode < 500 && (!expected || sha === expected) ? 0 : 1);',
    '} catch { process.stdout.write("invalid-json"); process.exit(1); }',
    '});',
    '});',
    'req.on("timeout", () => req.destroy(new Error("timeout")));',
    'req.on("error", (error) => { process.stdout.write("request-error " + error.message); process.exit(1); });',
  ].join('');
  return [
    '$ErrorActionPreference = "Stop"',
    `$remoteRoot = ${powershellPathExpression(remoteRoot)}`,
    `$logRoot = Join-Path $HOME "${REMOTE_HOME_DIRNAME}\\logs"`,
    'New-Item -ItemType Directory -Force -Path $logRoot | Out-Null',
    '$installLog = Join-Path $logRoot "install.log"',
    'function Log([string]$Message) { "$((Get-Date).ToUniversalTime().ToString("o")) $Message" | Add-Content -LiteralPath $installLog }',
    '$node = Join-Path $remoteRoot "node\\node.exe"',
    'if (-not (Test-Path -LiteralPath $node)) { throw "missing bundled node runtime" }',
    '$attempts = 90',
    '$lastStatus = ""',
    `Log "wait: waiting for /api/info on port ${safePort} expected=${expectedVersion || ''}"`,
    'while ($attempts -gt 0) {',
    `  $lastStatus = (& $node -e ${powershellSingleQuote(readinessProbeScript)} 2>&1) -join ""`,
    '  if ($LASTEXITCODE -eq 0) { Log "wait: ready $lastStatus"; exit 0 }',
    '  if (@(90,80,70,60,50,40,30,20,10,5,1) -contains $attempts) { Log "wait: not ready attempts=$attempts $lastStatus" }',
    '  $attempts -= 1',
    '  Start-Sleep -Seconds 1',
    '}',
    'Write-Error "Elevenex backend did not become ready on the remote host"',
    `Write-Error "Expected backend version: ${expectedVersion || ''}"`,
    'Write-Error "Last readiness status: $lastStatus"',
    '$backendLog = Join-Path $logRoot "backend.log"',
    'if (Test-Path -LiteralPath $backendLog) { Get-Content -LiteralPath $backendLog -Tail 120 | Write-Error }',
    'if (Test-Path -LiteralPath $installLog) { Get-Content -LiteralPath $installLog -Tail 160 | Write-Error }',
    'exit 1',
  ].join('\r\n');
}

function buildRemoteWaitForReadyCommand({ remoteRoot, remotePort, expectedVersion }) {
  const safePort = Number.isFinite(Number(remotePort)) ? Number(remotePort) : 11111;
  const readinessProbeScript = [
    `const expected = ${JSON.stringify(`${expectedVersion || ''}`)};`,
    'const http = require("http");',
    `const req = http.get({ host: "127.0.0.1", port: ${safePort}, path: "/api/info", timeout: 1200 }, (res) => {`,
    '  let body = "";',
    '  res.setEncoding("utf8");',
    '  res.on("data", (chunk) => body += chunk);',
    '  res.on("end", () => {',
    '    try {',
    '      const data = JSON.parse(body);',
    '      const sha = typeof data.backendSha === "string" ? data.backendSha : "";',
    '      process.stdout.write("status=" + res.statusCode + " sha=" + sha);',
    '      process.exit(res.statusCode && res.statusCode < 500 && (!expected || sha === expected) ? 0 : 1);',
    '    } catch {',
    '      process.stdout.write("invalid-json");',
    '      process.exit(1);',
    '    }',
    '  });',
    '});',
    'req.on("timeout", () => req.destroy(new Error("timeout")));',
    'req.on("error", (error) => {',
    '  process.stdout.write("request-error " + error.message);',
    '  process.exit(1);',
    '});',
  ].join('');
  return [
    'set -eu',
    `INSTALL_LOG="$HOME/${REMOTE_HOME_DIRNAME}/logs/install.log"`,
    'log() { printf "%s %s\\n" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$INSTALL_LOG"; }',
    `cd ${shellPathQuote(remoteRoot)}`,
    'if [ ! -x "./node/bin/node" ]; then',
    '  echo "missing bundled node runtime" >&2',
    '  exit 1',
    'fi',
    'ATTEMPTS=90',
    'LAST_STATUS=""',
    `log "wait: waiting for /api/info on port ${safePort} expected=${expectedVersion || ''}"`,
    'while [ "$ATTEMPTS" -gt 0 ]; do',
    `  LAST_STATUS="$(./node/bin/node -e ${shellSingleQuote(readinessProbeScript)} 2>&1)" && READY=1 || READY=0`,
    '  if [ "$READY" = "1" ]; then',
    '    log "wait: ready $LAST_STATUS"',
    '    exit 0',
    '  fi',
    '  case "$ATTEMPTS" in 90|80|70|60|50|40|30|20|10|5|1) log "wait: not ready attempts=$ATTEMPTS $LAST_STATUS" ;; esac',
    '  ATTEMPTS=$((ATTEMPTS - 1))',
    '  sleep 1',
    'done',
    'echo "Elevenex backend did not become ready on the remote host" >&2',
    `echo "Expected backend version: ${expectedVersion || ''}" >&2`,
    'echo "Last readiness status: $LAST_STATUS" >&2',
    'if tmux has-session -t elevenex-backend 2>/dev/null; then',
    '  echo "--- tmux elevenex-backend pane (last 80 lines) ---" >&2',
    '  tmux capture-pane -t elevenex-backend -p -S -80 2>&1 >&2 || true',
    'else',
    '  echo "--- tmux elevenex-backend session not found (backend exited) ---" >&2',
    'fi',
    `if [ -r "$HOME/${REMOTE_HOME_DIRNAME}/logs/backend.log" ]; then`,
    `  echo "--- ~/${REMOTE_HOME_DIRNAME}/logs/backend.log (last 120 lines) ---" >&2`,
    `  tail -n 120 "$HOME/${REMOTE_HOME_DIRNAME}/logs/backend.log" >&2 || true`,
    'fi',
    `if [ -r "$HOME/${REMOTE_HOME_DIRNAME}/logs/install.log" ]; then`,
    `  echo "--- ~/${REMOTE_HOME_DIRNAME}/logs/install.log (last 160 lines) ---" >&2`,
    `  tail -n 160 "$HOME/${REMOTE_HOME_DIRNAME}/logs/install.log" >&2 || true`,
    'fi',
    'exit 1',
  ].join('\n');
}

function getSuggestedInstallCommands(osRelease, platform = 'linux') {
  if (platform === 'win32') {
    return ['Install Claude Code for Windows and make sure `claude` is available in PATH.'];
  }

  if (platform === 'darwin') {
    return ['brew install tmux'];
  }

  const distroId = `${osRelease.ID || ''}`.toLowerCase();
  const distroFamily = `${osRelease.ID_LIKE || ''}`.toLowerCase();
  const values = `${distroId} ${distroFamily}`;

  if (values.includes('debian') || values.includes('ubuntu')) {
    return ['sudo apt update', 'sudo apt install -y tmux'];
  }

  if (values.includes('rhel') || values.includes('fedora') || values.includes('centos')) {
    return ['sudo dnf install -y tmux'];
  }

  if (values.includes('alpine')) {
    return ['sudo apk add tmux'];
  }

  if (values.includes('arch')) {
    return ['sudo pacman -Sy tmux'];
  }

  return ['Install tmux using your distro package manager.'];
}

module.exports = {
  REMOTE_HOME_DIRNAME,
  REMOTE_INSTALL_PHASES,
  REMOTE_RUNTIME_TARGETS,
  buildWindowsRemoteInstallCommand,
  buildWindowsRemotePreflightScript,
  buildWindowsRemoteStartCommand,
  buildWindowsRemoteWaitForReadyCommand,
  buildRemoteInstallCommand,
  buildRemotePreflightScript,
  buildRemoteStartCommand,
  buildRemoteWaitForReadyCommand,
  getSuggestedInstallCommands,
  normalizeRemoteArch,
  normalizeRemotePlatform,
  parseOsRelease,
  parseRemotePreflight,
  resolveRemoteRuntimeTarget,
  shellPathQuote,
  shellSingleQuote,
};
