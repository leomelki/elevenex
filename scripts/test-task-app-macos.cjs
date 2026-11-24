const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const { once } = require('node:events');
const { mkdtempSync, rmSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const { buildMacAppDisplay } = require('./build-task-app-macos.cjs');
const { testMacSupervisor } = require('./test-task-app-supervisor.cjs');

async function interactive(directory, helperPath) {
  // Use the installed helper whose privacy permissions the host user actually granted.
  const { DarwinAppDisplay } = require('../apps/backend/dist/task-apps/darwin-display.js');
  execFileSync(helperPath, ['--check'], { timeout: 3000 });
  const fixture = join(directory, 'test-window');
  execFileSync('/usr/bin/xcrun', ['clang', '-fobjc-arc', '-framework', 'AppKit',
    join(__dirname, 'fixtures/task-app-macos-window.m'), '-o', fixture], { stdio: 'inherit' });
  const app = spawn(helperPath, ['--launch', fixture], { stdio: ['pipe', 'pipe', 'inherit', 'pipe', 'pipe'] });
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
      if (!process.argv[3]) throw new Error('Specify the installed task-app-macos executable');
      await interactive(dir, resolve(process.argv[3]));
      return;
    }
    const outputPath = join(dir, 'task-app-macos');
    buildMacAppDisplay({ outputPath });
    const frame = execFileSync(outputPath, ['--self-test'], { timeout: 10000, maxBuffer: 3_000_009 });
    assert.equal(frame.readUInt32BE(0), frame.length - 9);
    assert.equal(frame.readUInt16BE(4), 64);
    assert.equal(frame.readUInt16BE(6), 64);
    assert.equal(frame[8], 1);
    const annexB = frame.subarray(9), start = Buffer.from([0, 0, 0, 1]);
    const nals = [];
    for (let i = annexB.indexOf(start); i >= 0; i = annexB.indexOf(start, i + 4)) nals.push(annexB[i + 4] & 31);
    assert.ok([7, 8, 5].every(type => nals.includes(type)), 'A fresh viewer needs SPS, PPS and IDR');
    assert.throws(() => execFileSync(outputPath, [String(process.pid)]), error => error.status === 2,
      'A process cannot nominate an arbitrary app PID for capture');
    await testMacSupervisor(outputPath);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
