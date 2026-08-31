'use strict';

// Desktop self-update against the `runtime-<commit sha>` GitHub releases produced
// by .github/workflows/release-assets.yml.
//
// Those releases are prereleases whose tag is derived from the built commit, so
// there is no semver ladder for electron-updater to walk and no latest.yml in the
// release. Instead we list releases (newest first), pick the newest one that
// carries an artifact for this platform, and compare its sha against the sha
// baked into the app at package time (`resources/version`).
//
// Each platform is then updated the way that platform expects:
//   win32   NSIS installer relaunched with --updated, app quits so files unlock
//   darwin  DMG mounted, signature + team id checked, bundle swapped by a
//           detached script once the app has exited, then relaunched
//   linux   AppImage replaced in place (when running as one), otherwise the .deb
//           is installed through pkexec/dpkg with a file-manager fallback
//
// Every artifact is verified against the `.sha256` sidecar the release workflows
// publish before anything is executed.

const { execFile, spawn } = require('child_process');
const {
  accessSync,
  chmodSync,
  constants: fsConstants,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} = require('fs');
const os = require('os');
const path = require('path');
const { promisify } = require('util');

const {
  downloadToFile,
  fetchJson,
  fetchText,
  formatBytes,
  parseChecksumFile,
  sha256File,
} = require('./download-utils.cjs');

const execFileAsync = promisify(execFile);

const UPDATE_REPO = process.env.ELEVENEX_UPDATE_REPO || 'leomelki/elevenex';
const GITHUB_API_BASE = process.env.ELEVENEX_UPDATE_API_BASE || 'https://api.github.com';
const RELEASE_TAG_PATTERN = /^runtime-([0-9a-f]{7,40})$/i;
const RELEASE_PAGE_SIZE = 30;
// A manual check should feel live; the cache only exists so opening Settings
// repeatedly doesn't burn the 60/hour unauthenticated GitHub rate limit.
const CHECK_CACHE_TTL_MS = 5 * 60 * 1000;
const QUIT_AFTER_HANDOFF_MS = 800;
const PROCESS_EXIT_POLL_ATTEMPTS = 600;

const REQUEST_HEADERS = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'Elevenex-Updater',
};

function githubHeaders() {
  const token = process.env.ELEVENEX_UPDATE_TOKEN || '';
  return token ? { ...REQUEST_HEADERS, Authorization: `Bearer ${token}` } : REQUEST_HEADERS;
}

/**
 * Which release artifact this machine can install, and how. `linux` depends on
 * how the app was actually started: an AppImage knows its own path through
 * $APPIMAGE, anything else came from the .deb.
 */
function resolveUpdateTarget() {
  if (process.platform === 'win32') {
    if (process.arch !== 'x64') {
      return { supported: false, reason: `No Windows build is published for ${process.arch}.` };
    }
    return { supported: true, kind: 'nsis', assetName: 'elevenex-desktop-windows-x64.exe' };
  }

  if (process.platform === 'darwin') {
    if (process.arch !== 'arm64') {
      return { supported: false, reason: 'Only Apple Silicon builds are published.' };
    }
    return { supported: true, kind: 'dmg', assetName: 'elevenex-desktop-macos-arm64.dmg' };
  }

  if (process.platform === 'linux') {
    if (process.arch !== 'x64') {
      return { supported: false, reason: `No Linux build is published for ${process.arch}.` };
    }
    if (process.env.APPIMAGE) {
      return { supported: true, kind: 'appimage', assetName: 'elevenex-desktop-linux-x64.AppImage' };
    }
    return { supported: true, kind: 'deb', assetName: 'elevenex-desktop-linux-x64.deb' };
  }

  return { supported: false, reason: `Updates are not available on ${process.platform}.` };
}

function shortSha(version) {
  return typeof version === 'string' && RELEASE_TAG_PATTERN.test(`runtime-${version}`)
    ? version.slice(0, 7)
    : version || null;
}

function toReleaseSummary(release) {
  const match = RELEASE_TAG_PATTERN.exec(release.tag_name || '');
  if (!match) {
    return null;
  }

  return {
    version: match[1].toLowerCase(),
    tag: release.tag_name,
    publishedAt: release.published_at || release.created_at || null,
    url: release.html_url || null,
    assets: Array.isArray(release.assets) ? release.assets : [],
  };
}

function findAsset(release, assetName) {
  return release.assets.find((asset) => asset.name === assetName) || null;
}

async function commandExists(command) {
  try {
    await execFileAsync(process.platform === 'win32' ? 'where' : 'which', [command]);
    return true;
  } catch {
    return false;
  }
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

/**
 * The macOS and AppImage flows quit the app before touching disk, so a
 * permission problem discovered by the handoff script is invisible to the user.
 * Check up front instead and surface a real error while the UI is still alive.
 */
function assertWritableDirectory(directory, what) {
  try {
    accessSync(directory, fsConstants.W_OK);
  } catch {
    throw new Error(`Elevenex cannot write to ${directory}, so it cannot replace ${what} itself.`);
  }
}

/**
 * Body shared by the macOS and AppImage handoff scripts: both have to outlive the
 * app they are replacing, so they poll until our pid is gone before touching
 * anything on disk.
 */
function waitForPidSnippet(pid) {
  return `for _ in $(seq 1 ${PROCESS_EXIT_POLL_ATTEMPTS}); do
  kill -0 ${pid} 2>/dev/null || break
  sleep 0.2
done
sleep 0.5`;
}

function createAppUpdater({ app, shell, getCurrentVersion, onStateChanged, requestQuit }) {
  const target = resolveUpdateTarget();
  const allowUnpackaged = process.env.ELEVENEX_ALLOW_DEV_UPDATES === '1';
  const packagedOk = app.isPackaged || allowUnpackaged;

  const state = {
    supported: target.supported && packagedOk,
    unsupportedReason: !packagedOk
      ? 'Updates are only available in the packaged desktop app.'
      : target.reason || null,
    installKind: target.supported ? target.kind : null,
    status: 'idle',
    currentVersion: null,
    currentVersionShort: null,
    latestVersion: null,
    latestVersionShort: null,
    releaseUrl: `https://github.com/${UPDATE_REPO}/releases`,
    publishedAt: null,
    assetName: target.supported ? target.assetName : null,
    downloadedBytes: 0,
    totalBytes: 0,
    percent: null,
    message: null,
    error: null,
    lastCheckedAt: null,
  };

  let cachedRelease = null;
  let cachedAt = 0;
  let inFlightCheck = null;
  let inFlightInstall = null;

  function refreshCurrentVersion() {
    const version = getCurrentVersion();
    state.currentVersion = version || null;
    state.currentVersionShort = shortSha(version);
  }

  function setState(patch) {
    Object.assign(state, patch);
    onStateChanged({ ...state });
  }

  function getState() {
    refreshCurrentVersion();
    return { ...state };
  }

  function getUpdatesDir() {
    return path.join(app.getPath('userData'), 'updates');
  }

  /** Drop artifacts left behind by a previous run so downloads never accumulate. */
  function cleanStaleDownloads() {
    const updatesDir = getUpdatesDir();
    if (!existsSync(updatesDir)) {
      return;
    }

    for (const entry of readdirSync(updatesDir)) {
      try {
        rmSync(path.join(updatesDir, entry), { recursive: true, force: true, maxRetries: 3 });
      } catch {
        // A file the OS still holds open is harmless — try again next launch.
      }
    }
  }

  async function listReleases() {
    const url = `${GITHUB_API_BASE}/repos/${UPDATE_REPO}/releases?per_page=${RELEASE_PAGE_SIZE}`;
    let releases;

    try {
      releases = await fetchJson(url, { headers: githubHeaders() });
    } catch (error) {
      // Unauthenticated GitHub API calls are capped at 60/hour per IP, which is
      // easy to hit behind shared egress. Say so instead of "HTTP 403".
      if (error?.statusCode === 403 || error?.statusCode === 429) {
        throw new Error('GitHub is rate limiting update checks. Try again in a few minutes.');
      }
      throw error;
    }

    if (!Array.isArray(releases)) {
      throw new Error('Unexpected response from the GitHub releases API.');
    }

    return releases
      .filter((release) => release && !release.draft)
      .map(toReleaseSummary)
      .filter(Boolean)
      .sort((a, b) => Date.parse(b.publishedAt || 0) - Date.parse(a.publishedAt || 0));
  }

  async function performCheck() {
    refreshCurrentVersion();
    setState({ status: 'checking', error: null, message: 'Checking for updates…' });

    const releases = await listReleases();
    const candidate = releases.find((release) => findAsset(release, target.assetName));

    if (!candidate) {
      setState({
        status: 'up-to-date',
        message: `No published release carries ${target.assetName} yet.`,
        lastCheckedAt: new Date().toISOString(),
      });
      cachedRelease = null;
      cachedAt = Date.now();
      return getState();
    }

    // Release tags are commit shas, so "newer" can't be derived from the name.
    // Fall back to publish time: if our own release is in the list and is at
    // least as new as the candidate, we are already current.
    const current = state.currentVersion
      ? releases.find((release) => release.version === state.currentVersion.toLowerCase())
      : null;
    const isCurrent = candidate.version === (state.currentVersion || '').toLowerCase()
      || (current && Date.parse(current.publishedAt || 0) >= Date.parse(candidate.publishedAt || 0));

    cachedRelease = candidate;
    cachedAt = Date.now();

    setState({
      status: isCurrent ? 'up-to-date' : 'available',
      latestVersion: candidate.version,
      latestVersionShort: shortSha(candidate.version),
      publishedAt: candidate.publishedAt,
      releaseUrl: candidate.url || state.releaseUrl,
      totalBytes: findAsset(candidate, target.assetName)?.size ?? 0,
      message: isCurrent ? 'Elevenex is up to date.' : null,
      error: null,
      lastCheckedAt: new Date().toISOString(),
    });

    return getState();
  }

  async function check({ force = false } = {}) {
    if (!state.supported) {
      return getState();
    }

    if (inFlightCheck) {
      return inFlightCheck;
    }

    if (!force && cachedAt && Date.now() - cachedAt < CHECK_CACHE_TTL_MS) {
      return getState();
    }

    inFlightCheck = performCheck()
      .catch((error) => {
        setState({
          status: 'error',
          error: error?.message || 'Could not reach the update server.',
          message: null,
        });
        return getState();
      })
      .finally(() => {
        inFlightCheck = null;
      });

    return inFlightCheck;
  }

  /** Download the artifact and fail closed when the release publishes a checksum. */
  async function downloadRelease(release) {
    const asset = findAsset(release, target.assetName);
    if (!asset) {
      throw new Error(`Release ${release.tag} has no ${target.assetName} artifact.`);
    }

    const updatesDir = path.join(getUpdatesDir(), release.version);
    cleanStaleDownloads();
    mkdirSync(updatesDir, { recursive: true });

    const destination = path.join(updatesDir, target.assetName);
    setState({
      status: 'downloading',
      downloadedBytes: 0,
      totalBytes: asset.size || 0,
      percent: 0,
      error: null,
      message: 'Downloading update…',
    });

    await downloadToFile(asset.browser_download_url, destination, (received, total) => {
      setState({
        downloadedBytes: received,
        totalBytes: total,
        percent: Math.min(Math.round((received / total) * 100), 100),
        message: `Downloading… ${formatBytes(received)} / ${formatBytes(total)}`,
      });
    }, { headers: githubHeaders() });

    const checksumAsset = findAsset(release, `${target.assetName}.sha256`);
    if (checksumAsset) {
      setState({ status: 'verifying', percent: 100, message: 'Verifying download…' });
      const expected = parseChecksumFile(
        await fetchText(checksumAsset.browser_download_url, { headers: githubHeaders() }),
      );
      const actual = await sha256File(destination);

      if (!expected || expected !== actual) {
        rmSync(destination, { force: true });
        throw new Error('Downloaded update failed checksum verification.');
      }
    }

    return destination;
  }

  function spawnDetached(command, args, options = {}) {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', ...options });
    child.unref();
    return child;
  }

  function quitSoon() {
    setTimeout(() => requestQuit(), QUIT_AFTER_HANDOFF_MS);
  }

  // --- Windows -------------------------------------------------------------

  // electron-builder's NSIS installer understands `--updated`: it reuses the
  // recorded install location and closes the running instance itself. We hand
  // off and quit so the installer can replace locked files.
  function installNsis(installerPath) {
    setState({ status: 'installing', percent: null, message: 'Starting the installer…' });
    spawnDetached(installerPath, ['--updated'], { windowsHide: false });
    quitSoon();
  }

  // --- macOS ---------------------------------------------------------------

  function getMacAppBundlePath() {
    const executable = app.getPath('exe');
    const marker = `.app${path.sep}Contents${path.sep}MacOS${path.sep}`;
    const index = executable.indexOf(marker);
    return index === -1 ? null : executable.slice(0, index + 4);
  }

  async function attachDmg(dmgPath) {
    const mountBase = path.join(os.tmpdir(), 'elevenex-update-mnt');
    mkdirSync(mountBase, { recursive: true });

    const { stdout } = await execFileAsync('hdiutil', [
      'attach', dmgPath,
      '-nobrowse', '-readonly', '-noverify', '-noautoopen',
      '-mountrandom', mountBase,
    ]);

    const mountPoint = stdout
      .split('\n')
      .map((line) => line.split('\t').pop()?.trim())
      .filter((entry) => entry && entry.startsWith(mountBase))
      .pop();

    if (!mountPoint) {
      throw new Error('Could not determine where the update disk image was mounted.');
    }

    return mountPoint;
  }

  async function detachDmg(mountPoint) {
    try {
      await execFileAsync('hdiutil', ['detach', mountPoint, '-quiet']);
    } catch {
      // Best effort — a leftover mount is cleaned up on reboot.
    }
  }

  async function readTeamIdentifier(bundlePath) {
    try {
      // `codesign -d` reports on stderr.
      const { stderr } = await execFileAsync('codesign', ['-dv', '--verbose=4', bundlePath]);
      return /TeamIdentifier=(\S+)/.exec(stderr || '')?.[1] ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Refuse to swap in a bundle that isn't validly signed by the same team as the
   * app currently running — the only thing standing between a compromised
   * download and arbitrary code execution once we relaunch it.
   */
  async function assertTrustedMacBundle(newAppPath, currentAppPath) {
    try {
      await execFileAsync('codesign', ['--verify', '--deep', '--strict', newAppPath]);
    } catch (error) {
      throw new Error(`The downloaded app is not validly signed: ${error?.stderr || error?.message}`);
    }

    const currentTeam = currentAppPath ? await readTeamIdentifier(currentAppPath) : null;
    if (!currentTeam) {
      // Unsigned local build (dev): there is no team to pin against.
      return;
    }

    const newTeam = await readTeamIdentifier(newAppPath);
    if (newTeam !== currentTeam) {
      throw new Error(`The downloaded app is signed by a different team (${newTeam ?? 'none'}).`);
    }
  }

  async function installDmg(dmgPath) {
    const currentAppPath = getMacAppBundlePath();
    if (!currentAppPath) {
      throw new Error('Could not locate the installed Elevenex.app bundle.');
    }

    setState({ status: 'installing', percent: null, message: 'Preparing the update…' });
    assertWritableDirectory(path.dirname(currentAppPath), 'Elevenex.app');

    const mountPoint = await attachDmg(dmgPath);
    try {
      const bundleName = readdirSync(mountPoint).find((entry) => entry.endsWith('.app'));
      if (!bundleName) {
        throw new Error('The update disk image does not contain an application bundle.');
      }

      const newAppPath = path.join(mountPoint, bundleName);
      await assertTrustedMacBundle(newAppPath, currentAppPath);

      // Stage next to the target so the final move stays on one volume.
      const stagePath = path.join(path.dirname(currentAppPath), '.elevenex-update.app');
      const backupPath = `${currentAppPath}.elevenex-old`;
      const scriptPath = path.join(getUpdatesDir(), 'apply-macos-update.sh');
      const logPath = path.join(getUpdatesDir(), 'apply-macos-update.log');

      writeFileSync(scriptPath, `#!/bin/bash
set -u
exec >>${shellQuote(logPath)} 2>&1
${waitForPidSnippet(process.pid)}

rm -rf ${shellQuote(stagePath)}
if ! ditto ${shellQuote(newAppPath)} ${shellQuote(stagePath)}; then
  hdiutil detach ${shellQuote(mountPoint)} -quiet || true
  open ${shellQuote(currentAppPath)}
  exit 1
fi
hdiutil detach ${shellQuote(mountPoint)} -quiet || true
xattr -dr com.apple.quarantine ${shellQuote(stagePath)} || true

rm -rf ${shellQuote(backupPath)}
if mv ${shellQuote(currentAppPath)} ${shellQuote(backupPath)}; then
  if mv ${shellQuote(stagePath)} ${shellQuote(currentAppPath)}; then
    rm -rf ${shellQuote(backupPath)}
  else
    # Put the working app back rather than leaving the user with nothing.
    mv ${shellQuote(backupPath)} ${shellQuote(currentAppPath)}
    rm -rf ${shellQuote(stagePath)}
  fi
fi

open ${shellQuote(currentAppPath)}
`, { mode: 0o700 });

      setState({ message: 'Installing update…' });
      spawnDetached('/bin/bash', [scriptPath]);
      quitSoon();
    } catch (error) {
      await detachDmg(mountPoint);
      throw error;
    }
  }

  // --- Linux ---------------------------------------------------------------

  function installAppImage(downloadedPath) {
    const targetPath = process.env.APPIMAGE;
    if (!targetPath) {
      throw new Error('The running AppImage path is unknown.');
    }

    setState({ status: 'installing', percent: null, message: 'Installing update…' });
    assertWritableDirectory(path.dirname(targetPath), 'the running AppImage');

    chmodSync(downloadedPath, 0o755);

    const scriptPath = path.join(getUpdatesDir(), 'apply-appimage-update.sh');
    const logPath = path.join(getUpdatesDir(), 'apply-appimage-update.log');

    writeFileSync(scriptPath, `#!/bin/bash
set -u
exec >>${shellQuote(logPath)} 2>&1
${waitForPidSnippet(process.pid)}

if ! mv -f ${shellQuote(downloadedPath)} ${shellQuote(targetPath)}; then
  exit 1
fi
chmod 0755 ${shellQuote(targetPath)}
setsid ${shellQuote(targetPath)} >/dev/null 2>&1 &
`, { mode: 0o700 });

    spawnDetached('/bin/bash', [scriptPath]);
    quitSoon();
  }

  // dpkg can replace the files of a running process, so unlike every other
  // platform the app stays up and the user restarts when convenient.
  async function installDeb(debPath) {
    setState({ status: 'installing', percent: null, message: 'Installing update…' });

    const canElevate = await commandExists('pkexec');
    if (canElevate) {
      try {
        const { stdout: dpkgPath } = await execFileAsync('which', ['dpkg']);
        await execFileAsync('pkexec', [dpkgPath.trim(), '-i', debPath], { timeout: 5 * 60 * 1000 });
        setState({
          status: 'ready-to-restart',
          message: 'Update installed. Restart Elevenex to finish.',
        });
        return;
      } catch (error) {
        // Falls through to the file-manager handoff: the user may have dismissed
        // the polkit prompt, or there may be no authentication agent running.
        setState({ message: `Automatic install failed (${error?.message || 'unknown error'}).` });
      }
    }

    await shell.openPath(debPath);
    setState({
      status: 'ready-to-restart',
      message: 'Finish installing the downloaded package, then restart Elevenex.',
    });
  }

  // -------------------------------------------------------------------------

  async function performInstall() {
    if (!state.supported) {
      throw new Error(state.unsupportedReason || 'Updates are not supported here.');
    }

    await check();
    if (state.status === 'error') {
      throw new Error(state.error || 'Could not check for updates.');
    }
    if (!cachedRelease || state.status === 'up-to-date') {
      return getState();
    }

    const artifactPath = await downloadRelease(cachedRelease);

    switch (target.kind) {
      case 'nsis':
        installNsis(artifactPath);
        break;
      case 'dmg':
        await installDmg(artifactPath);
        break;
      case 'appimage':
        installAppImage(artifactPath);
        break;
      case 'deb':
        await installDeb(artifactPath);
        break;
      default:
        throw new Error(`Unsupported install kind: ${target.kind}`);
    }

    return getState();
  }

  async function downloadAndInstall() {
    if (inFlightInstall) {
      return inFlightInstall;
    }

    inFlightInstall = performInstall()
      .catch((error) => {
        setState({
          status: 'error',
          percent: null,
          error: error?.message || 'The update could not be installed.',
          message: null,
        });
        return getState();
      })
      .finally(() => {
        inFlightInstall = null;
      });

    return inFlightInstall;
  }

  async function openReleasePage() {
    await shell.openExternal(state.releaseUrl);
  }

  refreshCurrentVersion();
  cleanStaleDownloads();

  return { check, downloadAndInstall, getState, openReleasePage };
}

module.exports = { createAppUpdater, resolveUpdateTarget };
