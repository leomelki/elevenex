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
  execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Set :CFBundleDisplayName Elevenex Agent', join(fixture, 'Contents/Info.plist')]);
  const executable = join(fixture, 'Contents/MacOS/Elevenex Agent');
  const source = resolve(__dirname, '../apps/backend/src/task-apps/native/macos');
  execFileSync('/usr/bin/xcrun', ['clang', '-fobjc-arc', '-mmacosx-version-min=14.0', '-I', source,
    join(__dirname, 'fixtures/task-app-agent-setup.m'), join(source, 'Setup.m'), join(source, 'SetupViews.m'),
    '-framework', 'AppKit', '-framework', 'ApplicationServices', '-framework', 'ScreenCaptureKit',
    '-o', executable], { stdio: 'inherit' });
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', fixture], { stdio: 'inherit' });
  const state = join(directory, 'permissions.json');
  const captures = [];
  const previous = join(directory,'Previous Setup.app');
  cpSync(fixture,previous,{recursive:true});
  const setupPIDFile = join(directory,'previous-setup.pid'), capturePIDFile = join(directory,'active-capture.pid');
  const alive = pid => { try { process.kill(pid,0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
  const waitFor = async condition => {
    for (let attempt=0; attempt<100; attempt++) { if (condition()) return; await new Promise(resolve=>setTimeout(resolve,50)); }
    throw new Error('Native setup replacement did not settle');
  };
  let setupPID, capturePID;
  const heldPIDs = [];
  try {
    for (const [mode,marker] of [['--hold-setup',setupPIDFile],['--hold-capture',capturePIDFile]]) {
      execFileSync('/usr/bin/open',['-n','-g','-a',previous,'--args',mode,marker],{timeout:5000});
      await waitFor(()=>existsSync(marker));
      heldPIDs.push(Number(readFileSync(marker,'utf8')));
    }
    setupPID = Number(readFileSync(setupPIDFile,'utf8')); capturePID = Number(readFileSync(capturePIDFile,'utf8'));
    writeFileSync(state,JSON.stringify({screen:false,input:false}));
    const file = 'replacement-current.png';
    execFileSync(executable,[join(output,file),'light'],{timeout:10000,env:{...process.env,ELEVENEX_AGENT_FIXTURE_STATE:state}});
    await waitFor(()=>!alive(setupPID));
    assert.equal(alive(capturePID),true,'Opening setup must preserve an active capture instance with the same bundle ID');
    const png = readFileSync(join(output,file));
    captures.push({name:'replacement-current',file,theme:'light',width:png.readUInt32BE(16),height:png.readUInt32BE(20)});
  } finally {
    for (const pid of heldPIDs) if (alive(pid)) process.kill(pid,'SIGTERM');
  }
  let displayName = 'Elevenex Agent';
  for (const [name, permission, theme, action = '', appName = 'Elevenex Agent'] of [
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
    ['development-identity-light', { screen: false, input: false }, 'light', 'plus', 'Elevenex Dev abc123'],
    ['development-identity-dark', { screen: false, input: false }, 'dark', 'plus', 'Elevenex Dev abc123'],
  ]) {
    if (appName !== displayName) {
      execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Set :CFBundleDisplayName ' + appName, join(fixture, 'Contents/Info.plist')]);
      execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', fixture], { stdio: 'inherit' });
      displayName = appName;
    }
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
      'reset cancellation on reopen', 'compact repair layout', 'replace old setup without stopping capture'],
  }, null, 2) + '\n');
}

async function interactive(directory, helperPath, control = true) {
  // Use the installed helper whose privacy permissions the host user actually granted.
  const { DarwinAppDisplay } = require('../apps/backend/dist/task-apps/darwin-display.js');
  execFileSync(helperPath, ['--check'], { timeout: 3000 });
  const fixture = join(directory, 'test-window');
  execFileSync('/usr/bin/xcrun', ['clang', '-fobjc-arc', '-framework', 'AppKit',
    join(__dirname, 'fixtures/task-app-macos-window.m'), '-o', fixture], { stdio: 'inherit' });
  const app = spawn(helperPath, ['--launch-desktop', fixture], { stdio: ['pipe', 'pipe', 'inherit', 'pipe', 'pipe'] });
  const exited = once(app, 'exit');
  app.stdin.write('GO\n');
  let markers = '';
  app.stdout.setEncoding('utf8').on('data', value => { markers += value; });
  const display = new DarwinAppDisplay(app);
  let phase = 'waiting for capture';
  const timeout = AbortSignal.timeout(45000), timedOut = new Promise((_, reject) => timeout.addEventListener('abort', () => reject(new Error(`Interactive app test timed out while ${phase}`))));
  const waitForMarker = async (marker, count = 1) => {
    phase = `waiting for ${marker} event ${count}`;
    while (markers.split(marker + '\n').length - 1 < count)
      await Promise.race([new Promise(resolve => setTimeout(resolve, 25)), timedOut]);
  };
  try {
    await Promise.race([once(app.stdio[3], 'data'), timedOut]);
    const image = Promise.withResolvers();
    let frames = 0;
    const interrupted = Promise.withResolvers();
    const stop = display.watch({ frame: frame => { frames++; image.resolve(frame); }, end: reason => {
      const error = new Error(reason);
      image.reject(error);
      interrupted.resolve(error);
    } });
    try {
      const frame = await Promise.race([image.promise, timedOut]);
      assert.ok(frame.key && frame.data.length > 0);
      // A first keyframe alone misses a false resize at the next 500ms tick:
      // WindowServer includes borders that ScreenCaptureKit can omit.
      const failure = await Promise.race([
        interrupted.promise,
        new Promise(resolve => setTimeout(resolve, 2000)),
        timedOut,
      ]);
      if (failure) throw failure;
      assert.ok(frames >= 2, 'A static app must keep producing refresh frames');
      if (!control) {
        console.log(`Native live capture: ${frames} frames across multiple window-monitor ticks`);
        return;
      }
      const point = { x: Math.floor(frame.width / 2), y: Math.floor(frame.height / 2), button: 0 };
      const click = async () => {
        for (const kind of ['down', 'up']) await display.input({ kind, ...point });
      };
      // macOS can briefly make its capture-consent prompt foreground. Wait
      // for the fixture to be eligible while verifying the private surface
      // itself still rejects pointer events.
      phase = 'waiting for foreground to return to the fixture';
      for (;;) {
        try {
          await display.input({ kind: 'down', button: 0,
            x: Math.round(frame.width * 28 / 480), y: Math.round(frame.height * 14 / 352) });
        } catch (error) {
          if (/input unavailable/.test(error.message)) break;
          if (!/foreground/.test(error.message)) throw error;
          await Promise.race([new Promise(resolve => setTimeout(resolve, 250)), timedOut]);
          continue;
        }
        assert.fail('A click on the private title-bar surface was accepted');
      }
      await click();
      await waitForMarker('clicked');
      await waitForMarker('released');
      await display.input({ kind: 'down', ...point });
      await display.input({ kind: 'move', x: point.x + 30, y: point.y + 30 });
      await display.input({ kind: 'up', ...point, x: point.x + 30, y: point.y + 30 });
      await waitForMarker('dragged');
      await waitForMarker('released', 2);
      await display.input({ kind: 'wheel', x: point.x, y: point.y, deltaX: 17, deltaY: 41 });
      await waitForMarker('scrolled');
      await display.input({ kind: 'key', code: 'KeyA', down: true });
      await display.input({ kind: 'key', code: 'KeyA', down: false });
      await display.input({ kind: 'text', text: 'é' });
      await waitForMarker('typed');
      await waitForMarker('text-received');
      await display.input({ kind: 'key', code: 'KeyB', down: true });
      await waitForMarker('dialog-open');
      const framesBeforeDialog = frames;
      // Wait for the dialog to enter WindowServer ordering. Its private
      // sharing policy must not accidentally classify it as title-bar chrome.
      await new Promise(resolve => setTimeout(resolve, 500));
      await assert.rejects(display.input({ kind: 'down', ...point }), /foreground/);
      await waitForMarker('dialog-closed');
      assert.ok(frames > framesBeforeDialog, 'A dialog must leave the picture live');
      await click();
      await waitForMarker('clicked', 3);
      console.log('Native live input: click, drag, scroll, key, Unicode text, dialog rejection and restored control verified');
    } finally { stop(); }
  } finally {
    app.stdin.end();
    await exited;
  }
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'elevenex-app-display-test-'));
  try {
    if (process.argv[2] === '--interactive' || process.argv[2] === '--capture-only') {
      if (!process.argv[3]) throw new Error('Specify the installed Elevenex Agent.app/Contents/MacOS/Elevenex Agent executable');
      await interactive(dir, resolve(process.argv[3]), process.argv[2] === '--interactive');
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
    for (const [width, height] of [[1440,959],[1920,1440],[1080,1920],[640,400],[3840,2160]]) {
      // Exercise the production sizing policy and real VideoToolbox encoder.
      // A 64x64-only codec smoke misses oversized ordinary Retina windows.
      const encoded = execFileSync(executable, ['--self-test-window',String(width),String(height)], { timeout: 10000, maxBuffer: 3_000_009 });
      const w = encoded.readUInt16BE(4), h = encoded.readUInt16BE(6);
      assert.equal(encoded.readUInt32BE(0), encoded.length-9);
      assert.equal(encoded[8],1);
      assert.ok(w >= 16 && h >= 16 && !(w&1) && !(h&1));
      assert.ok(w <= 1920 && h <= 1440 && w*h <= 1920*1080);
      assert.ok(Math.ceil(w/16)*Math.ceil(h/16) <= 8704, 'Baseline 4.2 macroblock budget');
      assert.ok(Math.abs(w/h-width/height) < 0.01, 'Preserve window aspect ratio');
      console.log(`Native H.264 window ${width}x${height} -> ${w}x${h}: encoded keyframe`);
    }
    assert.throws(() => execFileSync(executable, [String(process.pid)]), error => error.status === 2,
      'A process cannot nominate an arbitrary app PID for capture');
    await testMacSupervisor(executable);
    if (process.argv[2] === '--window-geometry') {
      const fixture = join(dir, 'window-geometry');
      const source = resolve(__dirname, '../apps/backend/src/task-apps/native/macos');
      execFileSync('/usr/bin/xcrun', ['clang', '-fobjc-arc', '-mmacosx-version-min=14.0', '-I', source,
        join(__dirname, 'fixtures/task-app-macos-window-geometry.m'), join(source, 'Input.m'),
        '-framework', 'AppKit', '-framework', 'ApplicationServices', '-framework', 'ScreenCaptureKit',
        '-o', fixture], { stdio: 'inherit' });
      execFileSync(fixture, [], { timeout: 10000, stdio: 'inherit' });
    }
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
