const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, realpathSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { setTimeout: wait } = require('node:timers/promises');
const { test } = require('node:test');
const { verifyMacAgentBundle } = require('./verify-task-app-macos.cjs');

const mac = { skip: process.platform !== 'darwin' };
function plistValue(bundle, key) {
  return execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :' + key, join(bundle, 'Contents/Info.plist')], { encoding: 'utf8' }).trim();
}
function requirement(bundle) {
  return execFileSync('/usr/bin/codesign', ['-d', '-r-', bundle], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    .trim().replace(/^#?\s*designated => /, '');
}

test('backend updates preserve ad hoc identity; changed helper code gets a distinct, matching identity', mac, t => {
  const directory = mkdtempSync(join(tmpdir(), 'elevenex-agent-update-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  // Copy only build inputs into an isolated project. No checkout source or real
  // installed helper is modified, and this test never grants privacy access.
  for (const path of ['apps/backend/src/task-apps/native/macos', 'docs/design-system/project/tokens.css', 'elevenex-logo.svg',
    ...['build-task-app-macos.cjs', 'task-app-macos-signing.cjs', 'verify-task-app-macos.cjs', 'desktop-icons.mjs'].map(name => 'scripts/' + name)]) {
    mkdirSync(join(directory, path, '..'), { recursive: true });
    cpSync(resolve(__dirname, '..', path), join(directory, path), { recursive: true });
  }
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('ELEVENEX_APP_DISPLAY_')) delete env[key];
  const build = name => {
    const bin = join(directory, name);
    execFileSync(process.execPath, [join(directory, 'scripts/build-task-app-macos.cjs'), bin], { env, timeout: 30000, stdio: 'pipe' });
    const bundle = join(bin, 'Elevenex Agent.app');
    verifyMacAgentBundle(bundle);
    return bundle;
  };
  const first = build('runtime-a/bin');
  // An unrelated engine revision and a different installation path must not
  // rotate the helper's bundle ID or its actual code signing requirement.
  writeFileSync(join(directory, 'backend-revision.txt'), 'unrelated backend update');
  const second = build('runtime-b/bin');
  const identifier = plistValue(first, 'CFBundleIdentifier');
  assert.match(identifier, /^com\.elevenex\.task-app-display\.development\.[a-f0-9]{20}$/);
  assert.equal(plistValue(second, 'CFBundleIdentifier'), identifier);
  assert.equal(requirement(second), requirement(first));
  execFileSync('/usr/bin/codesign', ['--verify', '-R', '=' + requirement(first), second], { stdio: 'pipe' });
  const source = join(directory, 'apps/backend/src/task-apps/native/macos/Input.m');
  writeFileSync(source, readFileSync(source, 'utf8') + '\nint agentUpdateRegression(void) { return 42; }\n');
  const changed = build('runtime-c/bin');
  assert.notEqual(plistValue(changed, 'CFBundleIdentifier'), identifier);
  assert.notEqual(plistValue(changed, 'CFBundleDisplayName'), plistValue(first, 'CFBundleDisplayName'));
  assert.notEqual(requirement(changed), requirement(first));
  assert.throws(() => execFileSync('/usr/bin/codesign', ['--verify', '-R', '=' + requirement(first), changed], { stdio: 'pipe' }));
  assert.throws(() => verifyMacAgentBundle(changed, { release: true }), /stable agent ID/);
});

test('release verification rejects ad hoc public code and plist/signature disagreement', mac, t => {
  const directory = mkdtempSync(join(tmpdir(), 'elevenex-agent-release-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bundle = join(directory, 'Elevenex Agent.app');
  mkdirSync(join(bundle, 'Contents/MacOS'), { recursive: true });
  cpSync(resolve(__dirname, '../apps/backend/src/task-apps/native/macos/Info.plist'), join(bundle, 'Contents/Info.plist'));
  cpSync('/usr/bin/true', join(bundle, 'Contents/MacOS/Elevenex Agent'));
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', 'com.elevenex.task-app-display', bundle], { stdio: 'pipe' });
  verifyMacAgentBundle(bundle);
  assert.throws(() => verifyMacAgentBundle(bundle, { release: true }));
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', 'com.elevenex.wrong-agent', bundle], { stdio: 'pipe' });
  assert.throws(() => verifyMacAgentBundle(bundle));
});

test('reopening by bundle ID selects the intended development build with old copies registered', { ...mac, skip: process.platform !== 'darwin' || process.env.ELEVENEX_TEST_MAC_AGENT_REOPEN !== '1' }, async t => {
  // LaunchServices can exclude applications in the system temporary tree from
  // bundle-ID lookup. Use disposable, ignored artifacts under the checkout,
  // like an installed runtime under the user's home directory.
  const artifacts = resolve(__dirname, '../artifacts');
  mkdirSync(artifacts, { recursive: true });
  const directory = mkdtempSync(join(artifacts, 'elevenex-agent-reopen-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const fixture = join(directory, 'identity-fixture');
  execFileSync('/usr/bin/xcrun', ['clang', '-fobjc-arc', '-framework', 'AppKit', '-framework', 'CoreServices', join(__dirname, 'fixtures/task-app-macos-reopen.m'), '-o', fixture]);
  const bundles = [];
  for (const revision of ['old', 'new']) {
    const bundle = join(directory, revision, 'Elevenex Agent.app');
    mkdirSync(join(bundle, 'Contents/MacOS'), { recursive: true });
    cpSync(fixture, join(bundle, 'Contents/MacOS/Elevenex Agent'));
    const identifier = 'com.elevenex.agent-reopen-fixture.' + directory.split('-').at(-1).toLowerCase() + '.' + revision;
    const plist = { CFBundleIdentifier: identifier, CFBundleName: 'Elevenex Reopen Fixture', CFBundleExecutable: 'Elevenex Agent', CFBundlePackageType: 'APPL', CFBundleVersion: '1', LSUIElement: true };
    writeFileSync(join(bundle, 'Contents/Info.plist'), execFileSync('/usr/bin/plutil', ['-convert', 'xml1', '-o', '-', '-'], { input: JSON.stringify(plist) }));
    execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', identifier, bundle], { stdio: 'pipe' });
    execFileSync(fixture, ['--register', bundle], { timeout: 5000 });
    bundles.push({ bundle, identifier });
  }
  let attempt = 0;
  async function open(args, expected) {
    const marker = join(directory, 'launch-' + ++attempt + '.json');
    execFileSync('/usr/bin/open', ['-n', '-g', ...args, '--args', marker], { timeout: 5000 });
    for (let count = 0; count < 100 && !existsSync(marker); count++) await wait(50);
    assert.deepEqual(JSON.parse(readFileSync(marker, 'utf8')), { identifier: expected.identifier, path: realpathSync(expected.bundle) });
  }
  for (const entry of bundles) await open(['-a', entry.bundle], entry);
  // Alternate old/new to reproduce a stale registration winning lookup. Each
  // ID must keep selecting its own copy, as System Settings does on reopen.
  for (const entry of [bundles[0], bundles[1], bundles[0], bundles[1]]) await open(['-b', entry.identifier], entry);
});
