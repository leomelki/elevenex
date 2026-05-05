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

  return normalized || 'unknown';
}

function normalizeRemoteArch(unameValue) {
  const normalized = `${unameValue || ''}`.trim().toLowerCase();

  if (['x86_64', 'amd64'].includes(normalized)) {
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

  if (data.has_tmux !== '1') {
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

function buildRemotePreflightScript(remotePort) {
  const safePort = Number(remotePort);
  return [
    'set -eu',
    'UNAME_S="$(uname -s 2>/dev/null || printf unknown)"',
    'UNAME_M="$(uname -m 2>/dev/null || printf unknown)"',
    'OS_RELEASE_RAW=""',
    'if [ -r /etc/os-release ]; then',
    '  OS_RELEASE_RAW="$(cat /etc/os-release)"',
    'fi',
    'if command -v claude >/dev/null 2>&1; then HAS_CLAUDE=1; else HAS_CLAUDE=0; fi',
    'if command -v tmux >/dev/null 2>&1; then HAS_TMUX=1; else HAS_TMUX=0; fi',
    'CURRENT_VERSION=""',
    'if [ -r "$HOME/.elevenex/current/version" ]; then',
    '  CURRENT_VERSION="$(tr -d \'\\r\\n\' < "$HOME/.elevenex/current/version")"',
    'fi',
    'TMUX_PRESENT=0',
    'if [ "$HAS_TMUX" = "1" ] && tmux has-session -t elevenex-backend 2>/dev/null; then',
    '  TMUX_PRESENT=1',
    'fi',
    'BACKEND_REACHABLE=0',
    'RUNNING_BACKEND_VERSION=""',
    'if [ -x "$HOME/.elevenex/current/node/bin/node" ]; then',
    `  if "$HOME/.elevenex/current/node/bin/node" -e "const http=require('http');const req=http.get({host:'127.0.0.1',port:${Number.isFinite(safePort) ? safePort : 11111},path:'/api/projects',timeout:1200},(res)=>{process.exit(res.statusCode&&res.statusCode<500?0:1)});req.on('timeout',()=>req.destroy(new Error('timeout')));req.on('error',()=>process.exit(1));" >/dev/null 2>&1; then`,
    '    BACKEND_REACHABLE=1',
    '  fi',
    `  RUNNING_BACKEND_VERSION="$("$HOME/.elevenex/current/node/bin/node" -e "const http=require('http');const req=http.get({host:'127.0.0.1',port:${Number.isFinite(safePort) ? safePort : 11111},path:'/api/info',timeout:1200},(res)=>{let body='';res.setEncoding('utf8');res.on('data',(chunk)=>body+=chunk);res.on('end',()=>{try{const data=JSON.parse(body);process.stdout.write(typeof data.backendSha==='string'?data.backendSha:'')}catch{process.exit(1)}})});req.on('timeout',()=>req.destroy(new Error('timeout')));req.on('error',()=>process.exit(1));" 2>/dev/null || true)"`,
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
  ].join('\n');
}

function buildRemoteInstallCommand({ remoteArchivePath, remoteReleaseDir, remoteCurrentLink }) {
  const releaseDir = shellPathQuote(remoteReleaseDir);
  return [
    'set -eu',
    'mkdir -p "$HOME/.elevenex/releases" "$HOME/.elevenex/tmp" "$HOME/.elevenex/logs"',
    `rm -rf ${releaseDir}`,
    `mkdir -p ${releaseDir}`,
    `tar -xzf ${shellPathQuote(remoteArchivePath)} -C ${releaseDir}`,
    `RELEASE_DIR=${releaseDir}`,
    'PTY_DIR="$(find "$RELEASE_DIR/node_modules/.pnpm" -maxdepth 4 -type d -path "*/node-pty@*/node_modules/node-pty" 2>/dev/null | head -n 1 || true)"',
    'if [ -n "$PTY_DIR" ] && [ ! -f "$PTY_DIR/build/Release/pty.node" ]; then',
    '  ARCH_KEY="$(uname -m)"',
    '  case "$ARCH_KEY" in x86_64|amd64) ARCH_KEY=x64 ;; aarch64) ARCH_KEY=arm64 ;; esac',
    '  if [ ! -f "$PTY_DIR/prebuilds/linux-$ARCH_KEY/pty.node" ]; then',
    '    if ! { command -v cc >/dev/null 2>&1 || command -v gcc >/dev/null 2>&1; } || ! command -v make >/dev/null 2>&1 || ! command -v python3 >/dev/null 2>&1; then',
    '      echo "Cannot compile node-pty on remote: missing build tools. Install gcc/cc, make, and python3, then retry." >&2',
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
    'if [ -d "$HOME/.elevenex/releases" ]; then',
    '  ls -1dt "$HOME/.elevenex/releases"/* 2>/dev/null | tail -n +3 | xargs rm -rf -- 2>/dev/null || true',
    'fi',
  ].join('\n');
}

function buildRemoteStartCommand({ remoteRoot, remotePort }) {
  const safePort = Number.isFinite(Number(remotePort)) ? Number(remotePort) : 11111;
  return [
    'set -eu',
    'if ! command -v tmux >/dev/null 2>&1; then',
    '  echo "tmux is required to start the Elevenex backend" >&2',
    '  exit 1',
    'fi',
    'mkdir -p "$HOME/.elevenex/logs"',
    'tmux kill-session -t elevenex-backend 2>/dev/null || true',
    `tmux new-session -d -s elevenex-backend ${shellPathQuote(`${remoteRoot}/bin/start-backend.sh ${safePort}`)}`,
  ].join('\n');
}

function buildRemoteWaitForReadyCommand({ remoteRoot, remotePort, expectedVersion }) {
  const safePort = Number.isFinite(Number(remotePort)) ? Number(remotePort) : 11111;
  const expectedVersionLiteral = JSON.stringify(`${expectedVersion || ''}`);
  return [
    'set -eu',
    `cd ${shellPathQuote(remoteRoot)}`,
    'if [ ! -x "./node/bin/node" ]; then',
    '  echo "missing bundled node runtime" >&2',
    '  exit 1',
    'fi',
    'ATTEMPTS=90',
    'while [ "$ATTEMPTS" -gt 0 ]; do',
    `  if ./node/bin/node -e "const expected=${expectedVersionLiteral};const http=require('http');const req=http.get({host:'127.0.0.1',port:${safePort},path:'/api/info',timeout:1200},(res)=>{let body='';res.setEncoding('utf8');res.on('data',(chunk)=>body+=chunk);res.on('end',()=>{try{const data=JSON.parse(body);process.exit(res.statusCode&&res.statusCode<500&&(!expected||data.backendSha===expected)?0:1)}catch{process.exit(1)}})});req.on('timeout',()=>req.destroy(new Error('timeout')));req.on('error',()=>process.exit(1));" >/dev/null 2>&1; then`,
    '    exit 0',
    '  fi',
    '  ATTEMPTS=$((ATTEMPTS - 1))',
    '  sleep 1',
    'done',
    'echo "Elevenex backend did not become ready on the remote host" >&2',
    'if tmux has-session -t elevenex-backend 2>/dev/null; then',
    '  echo "--- tmux elevenex-backend pane (last 80 lines) ---" >&2',
    '  tmux capture-pane -t elevenex-backend -p -S -80 2>&1 >&2 || true',
    'else',
    '  echo "--- tmux elevenex-backend session not found (backend exited) ---" >&2',
    'fi',
    'if [ -r "$HOME/.elevenex/logs/backend.log" ]; then',
    '  echo "--- ~/.elevenex/logs/backend.log (last 120 lines) ---" >&2',
    '  tail -n 120 "$HOME/.elevenex/logs/backend.log" >&2 || true',
    'fi',
    'exit 1',
  ].join('\n');
}

function getSuggestedInstallCommands(osRelease) {
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
  REMOTE_INSTALL_PHASES,
  REMOTE_RUNTIME_TARGETS,
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
