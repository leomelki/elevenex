const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, rmSync, statSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');

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
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], { stdio: 'inherit' });
    const displayName = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleDisplayName', join(bundle, 'Contents/Info.plist')], { encoding: 'utf8' }).trim();
    assert.equal(displayName, 'Elevenex Agent');
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
module.exports = { verifyMacAgentArchive };
if (require.main === module) {
  if (process.platform !== 'darwin' || !process.argv[2]) throw new Error('Supply the built macOS backend archive on a Mac');
  verifyMacAgentArchive(process.argv[2], {
    notarized: process.argv.includes('--require-notarized'),
    persistentCapture: process.argv.includes('--require-persistent-capture'),
  });
}
