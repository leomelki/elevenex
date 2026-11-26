const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const { createServer } = require('node:net');
const { join } = require('node:path');
const { realpathSync } = require('node:fs');
const { testMacSupervisor } = require('./test-task-app-supervisor.cjs');

/** Real LaunchServices and Unix-FD transfer; no capture permission is granted. */
async function testMacDesktopConnection(executable, directory) {
  await testMacSupervisor(executable, '--launch-desktop');
  // The unsigned, isolated fixture may have no grant. It must answer a real
  // permission/session result from the GUI, rather than time out or fail IPC.
  try { execFileSync(executable, ['--check'], { timeout: 8000, stdio: 'pipe' }); }
  catch (error) { assert.ok([20, 21].includes(error.status), 'Desktop permission check must reach the GUI agent: ' + error.message); }
  assert.throws(() => execFileSync(executable, ['--capture-owned', String(process.pid)], { timeout: 3000 }),
    error => error.status === 2, 'A caller cannot nominate a group for capture');

  const fakePath = join(directory, 'untrusted-owner');
  const server = createServer(socket => socket.end());
  server.listen(fakePath); await once(server, 'listening');
  try {
    const denied = spawn(executable, ['--desktop-connection', fakePath], { stdio: 'ignore' });
    assert.equal((await once(denied, 'exit'))[0], 25, 'Only this agent executable may delegate capture');
  } finally { await new Promise(resolve => server.close(resolve)); }

  const stdout = [], stderr = [];
  const env = { PATH: process.env.PATH, ELEVENEX_DESKTOP_TEST_VALUE: 'one value with spaces' };
  const child = spawn(executable, ['--launch-desktop', process.execPath, '-e',
    'process.stdout.write(JSON.stringify({cwd:process.cwd(), value:process.env.ELEVENEX_DESKTOP_TEST_VALUE, args:process.argv.slice(1)})); process.stderr.write("app-stderr"); setInterval(()=>{},1000)',
    'one argument with spaces'], { cwd: directory, env, stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => stdout.push(chunk));
  child.stderr.on('data', chunk => stderr.push(chunk));
  const exit = once(child, 'exit');
  const timeout = setTimeout(() => child.kill('SIGKILL'), 10000);
  let group;
  try {
    const ready = once(child.stdio[3], 'data');
    child.stdin.write('GO\n');
    group = JSON.parse((await ready)[0]).group;
    const reply = once(child.stdio[4], 'data');
    child.stdio[4].write('{"id":7,"kind":"unwatch"}\n');
    const receipt = (await reply)[0];
    assert.equal(receipt.readUInt32BE(0), 0);
    assert.equal(receipt.readUInt32BE(4), 7);
    assert.equal(receipt[8], 1, 'The GUI helper receives the real private display channel');
    child.kill('SIGTERM');
    await exit;
    assert.deepEqual(JSON.parse(Buffer.concat(stdout).toString()), {
      cwd: realpathSync(directory), value: env.ELEVENEX_DESKTOP_TEST_VALUE, args: ['one argument with spaces'],
    });
    assert.equal(Buffer.concat(stderr).toString(), 'app-stderr');
    assert.throws(() => process.kill(-group, 0), { code: 'ESRCH' }, 'Stopping the proxy drains the owned app');
  } finally {
    clearTimeout(timeout);
    child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    if (group) { try { process.kill(-group, 'SIGKILL'); } catch { /* already drained */ } }
  }
  // App exit status is still the original supervisor's status.
  const finished = spawn(executable, ['--launch-desktop', '/bin/sh', '-c', 'exit 7'], {
    cwd: directory, stdio: ['pipe', 'ignore', 'inherit', 'pipe', 'pipe'],
  });
  const done = once(finished, 'exit'); finished.stdin.write('GO\n');
  assert.equal((await done)[0], 7);
}

module.exports = { testMacDesktopConnection };
