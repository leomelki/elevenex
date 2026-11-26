const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, rmSync, statSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');

function verifyMacAgentBundle(bundle, { release = false } = {}) {
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], { stdio: 'inherit' });
  const plist = join(bundle, 'Contents/Info.plist');
  const value = key => execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :' + key, plist], { encoding: 'utf8' }).trim();
  const identifier = value('CFBundleIdentifier');
  const development = /^com\.elevenex\.task-app-display\.development\.([a-f0-9]{20})$/.exec(identifier);
  assert.ok(identifier === 'com.elevenex.task-app-display' || development, 'Unexpected macOS agent identity');
  assert.equal(value('CFBundleDisplayName'), development ? 'Elevenex Dev ' + development[1].slice(0, 6) : 'Elevenex Agent');
  // Check the signed identity too. A correct Info.plist alone does not keep
  // TCC's code requirement aligned with LaunchServices' bundle lookup.
  execFileSync('/usr/bin/codesign', ['--verify', '-R', `=identifier "${identifier}"`, bundle], { stdio: 'pipe' });
  if (release) {
    assert.equal(identifier, 'com.elevenex.task-app-display', 'Public releases must retain the stable agent ID');
    execFileSync('/usr/bin/codesign', ['--verify', '-R',
      '=anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists', bundle], { stdio: 'pipe' });
    const requirement = execFileSync('/usr/bin/codesign', ['--display', '-r-', bundle], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    assert.doesNotMatch(requirement, /cdhash/, 'Public updates must use a certificate identity, not a build hash');
  }
}

// Verify the public artifact after copying and archiving, not only the bundle
// in the build checkout. A missing resource or signature invalidates setup.
function verifyMacAgentArchive(archive, { notarized = false, persistentCapture = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'elevenex-agent-archive-'));
  try {
    execFileSync('/usr/bin/tar', ['-xzf', resolve(archive), '-C', directory,
      'backend/bin/Elevenex Agent.app'], { stdio: 'inherit' });
    const bundle = join(directory, 'backend/bin/Elevenex Agent.app');
    const executable = join(bundle, 'Contents/MacOS/Elevenex Agent');
    assert.ok(statSync(executable).isFile() && (statSync(executable).mode & 0o111) !== 0, 'Elevenex Agent executable is missing');
    verifyMacAgentBundle(bundle, { release: notarized });
    if (persistentCapture) {
      assert.ok(statSync(join(bundle, 'Contents/embedded.provisionprofile')).isFile(), 'Capture provisioning profile is missing');
      const signed = execFileSync('/usr/bin/codesign', ['--display', '--entitlements', '-', '--xml', bundle]);
      const claims = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], { input: signed, encoding: 'utf8' }));
      assert.equal(claims['com.apple.developer.persistent-content-capture'], true, 'Signed persistent capture entitlement is missing');
    }
    if (notarized) {
      execFileSync('/usr/bin/xcrun', ['stapler', 'validate', bundle], { stdio: 'inherit' });
      execFileSync('/usr/sbin/spctl', ['--assess', '--type', 'execute', bundle], { stdio: 'inherit' });
    }
    console.log('Archived Elevenex Agent bundle and signature verified');
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
module.exports = { verifyMacAgentArchive, verifyMacAgentBundle };
if (require.main === module) {
  if (process.platform !== 'darwin' || !process.argv[2]) throw new Error('Supply the built macOS backend archive on a Mac');
  verifyMacAgentArchive(process.argv[2], {
    notarized: process.argv.includes('--require-notarized'),
    persistentCapture: process.argv.includes('--require-persistent-capture'),
  });
}
