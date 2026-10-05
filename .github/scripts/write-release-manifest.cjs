const { createHash } = require('node:crypto');
const { createReadStream } = require('node:fs');
const { readFile, writeFile } = require('node:fs/promises');
const path = require('node:path');

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
  const desktopRuntime = [
    { key: 'macos-arm64', archive: 'elevenex-runtime-macos-arm64.tar.gz' },
    { key: 'linux-x64', archive: 'elevenex-runtime-linux-x64.tar.gz' },
    { key: 'windows-x64', archive: 'elevenex-runtime-windows-x64.tar.gz' },
  ];
  const desktop = [
    { key: 'macos-arm64', archive: 'elevenex-desktop-macos-arm64.dmg' },
    { key: 'linux-x64', archive: 'elevenex-desktop-linux-x64.AppImage' },
    { key: 'linux-x64', archive: 'elevenex-desktop-linux-x64.deb' },
    { key: 'windows-x64', archive: 'elevenex-desktop-windows-x64.exe' },
  ];
  for (const asset of [...targets, ...desktopRuntime, ...desktop]) {
    const checksum = (await readFile(path.join(artifactsDir, `${asset.archive}.sha256`), 'utf8')).trim();
    const expected = /^([a-f0-9]{64})\s+/i.exec(checksum)?.[1].toLowerCase();
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path.join(artifactsDir, asset.archive))) hash.update(chunk);
    asset.sha256 = hash.digest('hex');
    if (asset.sha256 !== expected) throw new Error(`Invalid checksum for ${asset.archive}`);
  }
  const sourceMaps = JSON.parse(await readFile(path.join(artifactsDir, 'source-maps-manifest.json'), 'utf8'));
  if (sourceMaps.version !== version || sourceMaps.releaseTag !== releaseTag) throw new Error('Source maps refer to another release.');
  const ref = pullRequest ? `refs/pull/${pullRequest}/head` : process.env.GITHUB_REF;
  const manifest = { version, ref, releaseTag, pullRequest, targets, desktopRuntime, desktop, sourceMaps };
  await writeFile(path.join(artifactsDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
