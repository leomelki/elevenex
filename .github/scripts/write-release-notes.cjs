const { readFile, writeFile } = require('node:fs/promises');
const { join } = require('node:path');

// Row order of the release table; each platform gets one row with all its packages.
const platformNames = {
  'macos-arm64': 'macOS (Apple Silicon)',
  'windows-x64': 'Windows (x64)',
  'linux-x64': 'Linux (x64)',
  'linux-arm64': 'Linux (ARM64)',
};
const packageKinds = { '.dmg': 'DMG', '.AppImage': 'AppImage', '.deb': 'DEB', '.exe': 'Installer' };

function packageKind(archive) {
  const extension = Object.keys(packageKinds).find(candidate => archive.endsWith(candidate));
  return extension ? packageKinds[extension] : 'file';
}

// Release notes are built from the validated manifest so every link names an
// asset that was actually published. Only desktop installers are listed; the
// backend and SSH runtime assets are still attached to the release.
function renderReleaseNotes({ manifest, repository, tag, sha, pullRequest }) {
  const base = `https://github.com/${repository}/releases/download/${tag}`;
  const rows = Object.entries(platformNames).flatMap(([key, name]) => {
    const links = manifest.desktop.filter(asset => asset.key === key)
      .map(({ archive }) => `[${packageKind(archive)}](${base}/${archive})`);
    return links.length ? [`| ${name} | ${links.join(' · ')} |`] : [];
  });
  const source = pullRequest
    ? `PR [#${pullRequest}](https://github.com/${repository}/pull/${pullRequest}) at commit [\`${sha.slice(0, 7)}\`](https://github.com/${repository}/commit/${sha})`
    : `commit [\`${sha.slice(0, 7)}\`](https://github.com/${repository}/commit/${sha})`;
  return [
    `Automated ${pullRequest ? 'preview ' : ''}build of ${source}.`,
    '',
    '## Download the desktop app',
    '',
    'The macOS DMG is signed and notarized. Linux packages are available as AppImage and DEB.',
    '',
    '| Platform | Download |',
    '| --- | --- |',
    ...rows,
    '',
  ].join('\n');
}

async function main() {
  const [artifactsDir, output] = process.argv.slice(2);
  const { RELEASE_REPOSITORY: repository, RELEASE_TAG: tag, RELEASE_SHA: sha, RELEASE_PR: pr } = process.env;
  if (!artifactsDir || !output || !repository || !tag || !/^[a-f0-9]{40}$/.test(sha || '')) {
    throw new Error('Usage: RELEASE_REPOSITORY, RELEASE_TAG and RELEASE_SHA are required: write-release-notes.cjs <artifacts> <output>');
  }
  const manifest = JSON.parse(await readFile(join(artifactsDir, 'manifest-new-desktop.json'), 'utf8'));
  await writeFile(output, renderReleaseNotes({ manifest, repository, tag, sha, pullRequest: pr ? Number(pr) : null }));
}

module.exports = { renderReleaseNotes };

if (require.main === module) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
