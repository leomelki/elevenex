const assert = require('node:assert/strict');
const { test } = require('node:test');
const { renderReleaseNotes } = require('./write-release-notes.cjs');

const sha = 'c'.repeat(40);
const manifest = {
  desktop: [
    { key: 'macos-arm64', archive: 'elevenex-new-desktop-macos-arm64.dmg' },
    { key: 'linux-x64', archive: 'elevenex-new-desktop-linux-x86_64.AppImage' },
    { key: 'linux-x64', archive: 'elevenex-new-desktop-linux-amd64.deb' },
    { key: 'windows-x64', archive: 'elevenex-new-desktop-windows-x64.exe' },
  ],
  backend: [{ key: 'linux-arm64', archive: 'elevenex-backend-linux-arm64.tar.gz' }],
  targets: [{ key: 'win32-x64', archive: 'elevenex-remote-runtime-win32-x64.zip' }],
};

test('links only the desktop installers under the release tag', () => {
  const tag = `runtime-${sha}`;
  const notes = renderReleaseNotes({ manifest, repository: 'owner/repo', tag, sha, pullRequest: null });
  const base = `https://github.com/owner/repo/releases/download/${tag}`;
  for (const { archive } of manifest.desktop) assert.ok(notes.includes(`(${base}/${archive})`), archive);
  for (const { archive } of [...manifest.backend, ...manifest.targets]) assert.ok(!notes.includes(archive), archive);
  assert.ok(!notes.includes('.sha256'));
  assert.match(notes, /\| macOS \(Apple Silicon\) \| \[DMG\]/);
  assert.match(notes, /\| Windows \(x64\) \| \[Installer\]/);
  assert.match(notes, /\| Linux \(x64\) \| \[AppImage\]\([^)]*\) · \[DEB\]\([^)]*\) \|/);
  assert.ok(notes.indexOf('| Windows') < notes.indexOf('| Linux'));
  assert.equal(notes.match(/\| Linux \(x64\)/g).length, 1);
  assert.match(notes, /commit \[`ccccccc`\]/);
});

test('names the pull request for previews', () => {
  const notes = renderReleaseNotes({ manifest, repository: 'owner/repo', tag: `runtime-pr-7-${sha}`, sha, pullRequest: 7 });
  assert.match(notes, /Automated preview build of PR \[#7\]\(https:\/\/github\.com\/owner\/repo\/pull\/7\)/);
});
