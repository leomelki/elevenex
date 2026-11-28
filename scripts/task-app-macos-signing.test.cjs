const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { test } = require('node:test');
const { prepareMacAppCaptureSigning } = require('./task-app-macos-signing.cjs');
const { verifyMacAgentArchive } = require('./verify-task-app-macos.cjs');

const capture = 'com.apple.developer.persistent-content-capture';
const app = 'com.apple.application-identifier';
const team = 'com.apple.developer.team-identifier';
const mac = { skip: process.platform !== 'darwin' };

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'elevenex-capture-signing-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bundle = join(directory, 'Elevenex Agent.app');
  const contents = join(bundle, 'Contents');
  mkdirSync(contents, { recursive: true });
  return { bundle, contents, directory, identity: 'Developer ID Application: Test Fixture' };
}

function profileFixture(directory, overrides = {}) {
  const payload = {
    Entitlements: {
      [capture]: true, [app]: 'TESTPREFIX.com.elevenex.task-app-display', [team]: 'TESTTEAM',
      'get-task-allow': true, 'fixture-data': 'AAEC',
    },
    ProvisionsAllDevices: true,
    ExpirationDate: '2099-01-01T00:00:00Z',
    ...overrides,
  };
  const plist = execFileSync('/usr/bin/plutil', ['-convert', 'xml1', '-o', '-', '-'], { input: JSON.stringify(payload), encoding: 'utf8' })
    .replace(`<string>${payload.ExpirationDate}</string>`, `<date>${payload.ExpirationDate}</date>`)
    .replace('<string>AAEC</string>', '<data>AAEC</data>');
  const profile = join(directory, 'fixture.provisionprofile');
  // An unsigned CMS data fixture exercises Apple's decoder and plist tools.
  // It is not an Apple-authorized profile and must never be used to launch.
  execFileSync('/usr/bin/openssl', ['cms', '-data_create', '-outform', 'DER', '-out', profile], { input: plist });
  return profile;
}

test('capture entitlement stays absent when no profile is configured', t => {
  const options = fixture(t);
  assert.deepEqual(prepareMacAppCaptureSigning({ ...options, identity: '-' }), []);
  assert.equal(existsSync(join(options.contents, 'embedded.provisionprofile')), false);
});

test('capture cannot be opted into with ad hoc signing', () => {
  for (const identity of ['-', undefined, '']) {
    assert.throws(() => prepareMacAppCaptureSigning({ identity, profile: '/unused/profile' }), /Developer ID signing identity/);
  }
});

test('profile contributes only capture and identity claims to the signed bundle', mac, t => {
  const options = fixture(t);
  const profile = profileFixture(options.directory);
  const args = prepareMacAppCaptureSigning({ ...options, profile });
  const claims = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', args[1]], { encoding: 'utf8' }));
  assert.deepEqual(claims, { [capture]: true, [app]: 'TESTPREFIX.com.elevenex.task-app-display', [team]: 'TESTTEAM' });
  assert.deepEqual(readFileSync(join(options.contents, 'embedded.provisionprofile')), readFileSync(profile));

  // Verify these arguments produce actual signed entitlements, without running
  // the fixture or requesting screen access. OS authorization needs a real profile.
  mkdirSync(join(options.contents, 'MacOS'));
  copyFileSync('/usr/bin/true', join(options.contents, 'MacOS/Elevenex Agent'));
  copyFileSync(resolve(__dirname, '../apps/backend/src/task-apps/native/macos/Info.plist'), join(options.contents, 'Info.plist'));
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', 'com.elevenex.task-app-display', ...args, options.bundle], { stdio: 'pipe' });
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', options.bundle], { stdio: 'pipe' });
  const signed = execFileSync('/usr/bin/codesign', ['--display', '--entitlements', '-', '--xml', options.bundle]);
  const signedClaims = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], { input: signed, encoding: 'utf8' }));
  assert.deepEqual(signedClaims, claims);

  mkdirSync(join(options.directory, 'backend/bin'), { recursive: true });
  cpSync(options.bundle, join(options.directory, 'backend/bin/Elevenex Agent.app'), { recursive: true });
  const archive = join(options.directory, 'backend.tar.gz');
  execFileSync('/usr/bin/tar', ['-czf', archive, '-C', options.directory, 'backend']);
  verifyMacAgentArchive(archive, { persistentCapture: true });

  // A signed bundle alone is insufficient if its capture claim was dropped.
  const dropped = join(options.directory, 'dropped-entitlements.plist');
  writeFileSync(dropped, execFileSync('/usr/bin/plutil', ['-convert', 'xml1', '-o', '-', '-'], { input: JSON.stringify({ [team]: 'TESTTEAM' }) }));
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--entitlements', dropped, options.bundle], { stdio: 'pipe' });
  cpSync(options.bundle, join(options.directory, 'backend/bin/Elevenex Agent.app'), { recursive: true });
  execFileSync('/usr/bin/tar', ['-czf', archive, '-C', options.directory, 'backend']);
  assert.throws(() => verifyMacAgentArchive(archive, { persistentCapture: true }), /persistent capture entitlement is missing/);
});

test('missing and malformed profiles fail instead of silently dropping capture', mac, t => {
  const options = fixture(t);
  assert.throws(() => prepareMacAppCaptureSigning({ ...options, profile: join(options.directory, 'missing') }), /ENOENT/);
  const profile = join(options.directory, 'invalid.provisionprofile');
  writeFileSync(profile, 'not a provisioning profile');
  assert.throws(() => prepareMacAppCaptureSigning({ ...options, profile }));
  assert.equal(existsSync(join(options.contents, 'embedded.provisionprofile')), false);
});

for (const [name, overrides, error] of [
  ['unapproved capture', { Entitlements: { [capture]: false } }, /does not authorize/],
  ['string instead of boolean', { Entitlements: { [capture]: 'true' } }, /does not authorize/],
  ['wrong application', { Entitlements: { [capture]: true, [app]: 'TESTTEAM.com.other.app', [team]: 'TESTTEAM' } }, /profile for com.elevenex/],
  ['missing team', { Entitlements: { [capture]: true, [app]: 'TESTPREFIX.com.elevenex.task-app-display' } }, /team identifier/],
  ['development profile', { ProvisionsAllDevices: false }, /Developer ID distribution/],
  ['distribution flag stored as a string', { ProvisionsAllDevices: 'true' }, /Developer ID distribution/],
  ['expired profile', { ExpirationDate: '2000-01-01T00:00:00Z' }, /has expired/],
]) {
  test(`rejects ${name} before embedding a profile`, mac, t => {
    const options = fixture(t);
    const profile = profileFixture(options.directory, overrides);
    assert.throws(() => prepareMacAppCaptureSigning({ ...options, profile }), error);
    assert.equal(existsSync(join(options.contents, 'embedded.provisionprofile')), false);
  });
}
