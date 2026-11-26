const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const { once } = require('node:events');
const { mkdtempSync, rmSync, readFileSync, existsSync, cpSync, mkdirSync, writeFileSync, readdirSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const { buildMacAppDisplay } = require('./build-task-app-macos.cjs');
const { testMacSupervisor } = require('./test-task-app-supervisor.cjs');
const { testMacDesktopConnection } = require('./test-task-app-macos-desktop.cjs');

async function setupPreview(directory, bundle, output) {
  mkdirSync(output, { recursive: true });
  if (readdirSync(output).length) throw new Error('Use an empty directory for native setup captures.');
  const fixture = join(directory, 'Setup Fixture.app');
  cpSync(bundle, fixture, { recursive: true });
  execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Set :CFBundleIdentifier com.elevenex.task-app-setup-fixture',
    join(fixture, 'Contents/Info.plist')]);
  const executable = join(fixture, 'Contents/MacOS/Elevenex Agent');
  const source = resolve(__dirname, '../apps/backend/src/task-apps/native/macos');
  execFileSync('/usr/bin/xcrun', ['clang', '-fobjc-arc', '-mmacosx-version-min=14.0', '-I', source,
    join(__dirname, 'fixtures/task-app-agent-setup.m'), join(source, 'Setup.m'), join(source, 'SetupViews.m'),
    '-framework', 'AppKit', '-framework', 'ApplicationServices', '-framework', 'ScreenCaptureKit',
    '-o', executable], { stdio: 'inherit' });
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', fixture], { stdio: 'inherit' });
  const state = join(directory, 'permissions.json');
  const captures = [];
  for (const [name, permission, theme, action = ''] of [
    ['screen-light', { screen: false, input: false }, 'light'],
    ['screen-dark', { screen: false, input: false }, 'dark'],
    ['accessibility', { screen: true, input: false }, 'light'],
    ['enabled', { screen: true, input: true }, 'light'],
    ['enabled-dark', { screen: true, input: true }, 'dark'],
    ['missed-drop', { screen: false, input: false }, 'light', 'missed-drop'],
    ['missed-drop-dark', { screen: false, input: false }, 'dark', 'missed-drop'],
    ['plus-alternative', { screen: false, input: false }, 'light', 'plus'],
    ['plus-alternative-dark', { screen: false, input: false }, 'dark', 'plus'],
    ['escape-alternative', { screen: false, input: false }, 'light', 'escape-alternative'],
    ['viewing-only', { screen: true, input: false }, 'light', 'viewing-only'],
    ['viewing-only-dark', { screen: true, input: false }, 'dark', 'viewing-only'],
    ['resume-input', { screen: true, input: false }, 'light', 'resume-input'],
    ['permission-transition', { screen: false, input: false }, 'light', 'transition'],
    ['reopen-after-revocation', { screen: true, input: true }, 'light', 'reopen'],
    ['accessibility-repair-help', { screen: true, input: false }, 'light', 'reset-help'],
    ['accessibility-repair-help-dark', { screen: true, input: false }, 'dark', 'reset-help'],
    ['accessibility-repair-success', { screen: true, input: false }, 'light', 'reset-success'],
    ['accessibility-repair-success-dark', { screen: true, input: false }, 'dark', 'reset-success'],
    ['accessibility-repair-failure', { screen: true, input: false }, 'light', 'reset-failure'],
    ['accessibility-repair-failure-dark', { screen: true, input: false }, 'dark', 'reset-failure'],
    ['accessibility-repair-launch-failure', { screen: true, input: false }, 'light', 'reset-launch-failure'],
    ['accessibility-repair-busy', { screen: true, input: false }, 'light', 'reset-busy'],
    ['accessibility-repair-timeout', { screen: true, input: false }, 'light', 'reset-timeout'],
    ['accessibility-repair-retry', { screen: true, input: false }, 'light', 'reset-retry'],
    ['accessibility-repair-granted', { screen: true, input: false }, 'light', 'reset-then-enabled'],
    ['accessibility-repair-close', { screen: true, input: false }, 'light', 'reset-close'],
    ['accessibility-repair-reopen', { screen: true, input: false }, 'light', 'reset-reopen'],
    ['accessibility-repair-compact', { screen: true, input: false }, 'light', 'reset-success-compact'],
    ['accessibility-repair-failure-compact-dark', { screen: true, input: false }, 'dark', 'reset-failure-compact'],
  ]) {
    writeFileSync(state, JSON.stringify(permission));
    const stdout = execFileSync(executable, [join(output, name + '.png'), theme, action], {
      stdio: ['ignore', 'pipe', 'inherit'], timeout: 10000,
      env: { ...process.env, ELEVENEX_AGENT_FIXTURE_STATE: state },
    });
    process.stdout.write(stdout);
    const resetChild = stdout.toString().match(/RESET_CHILD_PID=(\d+)/);
    if (resetChild) {
      // Allow launchd to reap the killed child after its setup parent exits.
      const pid = Number(resetChild[1]);
      let alive = true;
      for (let attempt = 0; attempt < 20 && alive; attempt++) {
        try { process.kill(pid, 0); } catch (error) { if (error.code !== 'ESRCH') throw error; alive = false; }
        if (alive) await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.equal(alive, false, 'Closing setup must stop its pending Accessibility reset');
    }
    const bytes = readFileSync(join(output, name + '.png'));
    assert.equal(bytes.subarray(1,4).toString(), 'PNG');
    captures.push({ name, file: name + '.png', theme, permissions: JSON.parse(readFileSync(state, 'utf8')), action,
      width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) });
  }
  writeFileSync(join(output, 'report.json'), JSON.stringify({
    verified: true, kind: 'native-setup', permissionFixtures: true,
    captures, checks: ['native compilation', 'bundle signature', 'process cleanup', 'visible control bounds',
      'missed drop feedback', 'manual alternative', 'Escape', 'viewing-only completion', 'resume input', 'live permission transition', 'fresh checks on reopen',
      'explicit reset intent', 'repair keyboard focus', 'reset success requires a fresh grant', 'reset failure fallback',
      'reset launch failure', 'reset busy controls', 'reset timeout', 'reset retry', 'grant after reset', 'reset cleanup on close',
      'reset cancellation on reopen', 'compact repair layout'],
  }, null, 2) + '\n');
}

async function interactive(directory, helperPath) {
  // Use the installed helper whose privacy permissions the host user actually granted.
  const { DarwinAppDisplay } = require('../apps/backend/dist/task-apps/darwin-display.js');
  execFileSync(helperPath, ['--check'], { timeout: 3000 });
  const fixture = join(directory, 'test-window');
  execFileSync('/usr/bin/xcrun', ['clang', '-fobjc-arc', '-framework', 'AppKit',
    join(__dirname, 'fixtures/task-app-macos-window.m'), '-o', fixture], { stdio: 'inherit' });
  const app = spawn(helperPath, ['--launch-desktop', fixture], { stdio: ['pipe', 'pipe', 'inherit', 'pipe', 'pipe'] });
  const exited = once(app, 'exit');
  app.stdin.write('GO\n');
  const received = Promise.withResolvers();
  let markers = '';
  app.stdout.setEncoding('utf8').on('data', value => {
    markers += value;
    if (markers.includes('clicked\n') && markers.includes('typed\n')) received.resolve();
  });
  const display = new DarwinAppDisplay(app);
  const timeout = AbortSignal.timeout(20000), timedOut = new Promise((_, reject) => timeout.addEventListener('abort', () => reject(new Error('Interactive capture or input timed out'))));
  try {
    await Promise.race([once(app.stdio[3], 'data'), timedOut]);
    const image = Promise.withResolvers();
    const stop = display.watch({ frame: frame => image.resolve(frame), end: reason => image.reject(new Error(reason)) });
    try {
      const frame = await Promise.race([image.promise, timedOut]);
      assert.ok(frame.key && frame.data.length > 0);
      const point = { x: Math.floor(frame.width / 2), y: Math.floor(frame.height / 2), button: 0 };
      for (const event of [{ kind: 'down', ...point }, { kind: 'up', ...point },
        { kind: 'key', code: 'KeyA', down: true }, { kind: 'key', code: 'KeyA', down: false }]) await display.input(event);
      await Promise.race([received.promise, timedOut]);
    } finally { stop(); }
  } finally {
    app.stdin.end();
    await exited;
  }
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'elevenex-app-display-test-'));
  try {
    if (process.argv[2] === '--interactive') {
      if (!process.argv[3]) throw new Error('Specify the installed Elevenex Agent.app/Contents/MacOS/Elevenex Agent executable');
      await interactive(dir, resolve(process.argv[3]));
      return;
    }
    const { bundle, executable } = await buildMacAppDisplay({ binDirectory: dir });
    assert.equal(existsSync(join(dir, 'task-app-macos')), false, 'Runtime archives cannot carry a CLI alias link');
    assert.ok(readFileSync(join(bundle, 'Contents/Resources/Agent.icns')).length > 100);
    execFileSync('/usr/bin/codesign', ['--verify','--deep','--strict',bundle], {stdio:'inherit'});
    const frame = execFileSync(executable, ['--self-test'], { timeout: 10000, maxBuffer: 3_000_009 });
    assert.equal(frame.readUInt32BE(0), frame.length - 9);
    assert.equal(frame.readUInt16BE(4), 64);
    assert.equal(frame.readUInt16BE(6), 64);
    assert.equal(frame[8], 1);
    const annexB = frame.subarray(9), start = Buffer.from([0, 0, 0, 1]);
    const nals = [];
    for (let i = annexB.indexOf(start); i >= 0; i = annexB.indexOf(start, i + 4)) nals.push(annexB[i + 4] & 31);
    assert.ok([7, 8, 5].every(type => nals.includes(type)), 'A fresh viewer needs SPS, PPS and IDR');
    assert.throws(() => execFileSync(executable, [String(process.pid)]), error => error.status === 2,
      'A process cannot nominate an arbitrary app PID for capture');
    await testMacSupervisor(executable);
    if (process.argv[2] === '--desktop-connection') {
      const fixture = join(dir, 'Desktop Connection Fixture.app');
      cpSync(bundle, fixture, { recursive: true });
      execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Set :CFBundleIdentifier com.elevenex.task-app-desktop-fixture', join(fixture, 'Contents/Info.plist')]);
      execFileSync('/usr/bin/codesign', ['--force', '--identifier', 'com.elevenex.task-app-desktop-fixture', '--sign', '-', fixture], { stdio: 'inherit' });
      await testMacDesktopConnection(join(fixture, 'Contents/MacOS/Elevenex Agent'), dir);
      console.log('Native desktop connection: verified launch gate, permissions probe, peer rejection, control channel, cwd/env/argv/stdio, exit and cleanup.');
    }
    if (process.argv[2] === '--setup-preview') {
      if (!process.argv[3]) throw new Error('Supply an output directory for setup previews');
      await setupPreview(dir, bundle, resolve(process.argv[3]));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
