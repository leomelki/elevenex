const { readFile, readdir, writeFile } = require('node:fs/promises');
const { join } = require('node:path');
const { sha256 } = require('./stage-release-assets.cjs');

async function main() {
  const artifactsDir = process.argv[2];
  const version = process.env.RELEASE_SHA;
  const releaseTag = process.env.RELEASE_TAG;
  const pullRequest = process.env.RELEASE_PR ? Number(process.env.RELEASE_PR) : null;
  if (!artifactsDir || !/^[a-f0-9]{40}$/.test(version || '')) throw new Error('Missing release directory or commit.');
  if (releaseTag !== (pullRequest ? `runtime-pr-${pullRequest}-${version}` : `runtime-${version}`)) {
    throw new Error('Release tag does not match its source commit.');
  }
  const targets = [
    { key: 'linux-x64', archive: 'elevenex-remote-runtime-linux-x64.tar.gz' },
    { key: 'linux-arm64', archive: 'elevenex-remote-runtime-linux-arm64.tar.gz' },
    { key: 'darwin-arm64', archive: 'elevenex-remote-runtime-darwin-arm64.tar.gz' },
    { key: 'win32-x64', archive: 'elevenex-remote-runtime-win32-x64.zip' },
  ];
  const desktop = [
    { key: 'macos-arm64', archive: 'elevenex-new-desktop-macos-arm64.dmg' },
    { key: 'linux-x64', archive: 'elevenex-new-desktop-linux-x86_64.AppImage' },
    { key: 'linux-x64', archive: 'elevenex-new-desktop-linux-amd64.deb' },
    { key: 'linux-arm64', archive: 'elevenex-new-desktop-linux-arm64.AppImage' },
    { key: 'linux-arm64', archive: 'elevenex-new-desktop-linux-arm64.deb' },
    { key: 'windows-x64', archive: 'elevenex-new-desktop-windows-x64.exe' },
  ];
  const backend = [
    { key: 'macos-arm64', archive: 'elevenex-backend-macos-arm64.tar.gz' },
    { key: 'linux-x64', archive: 'elevenex-backend-linux-x64.tar.gz' },
    { key: 'linux-arm64', archive: 'elevenex-backend-linux-arm64.tar.gz' },
    { key: 'windows-x64', archive: 'elevenex-backend-windows-x64.tar.gz' },
  ];
  const assets = [...targets, ...desktop, ...backend];
  const expectedFiles = new Set(assets.flatMap(({ archive }) => [archive, `${archive}.sha256`]));
  for (const file of await readdir(artifactsDir)) {
    if (!expectedFiles.has(file)) throw new Error(`Unexpected release asset: ${file}`);
  }
  for (const asset of assets) {
    const file = join(artifactsDir, asset.archive);
    const checksum = (await readFile(`${file}.sha256`, 'utf8')).trim();
    const match = /^([a-f0-9]{64})[ \t]+\*?(\S+)$/i.exec(checksum);
    if (match?.[2] !== asset.archive) throw new Error(`Invalid checksum filename for ${asset.archive}`);
    asset.sha256 = await sha256(file);
    if (asset.sha256 !== match[1].toLowerCase()) throw new Error(`Invalid checksum for ${asset.archive}`);
  }
  const ref = pullRequest ? `refs/pull/${pullRequest}/head` : process.env.GITHUB_REF;
  // Keep the manifest shape and filename published by the desktop previews.
  const manifest = { version, ref, releaseTag, pullRequest, targets, desktopRuntime: [], desktop, backend, sourceMaps: null };
  await writeFile(join(artifactsDir, 'manifest-new-desktop.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
