const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { mkdtempSync, existsSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

/** Native helper lifetime smoke. The launcher exits immediately and its app keeps the group alive. */
async function testMacSupervisor(executable) {
  const scratch = mkdtempSync(join(tmpdir(), 'elevenex-launch-gate-'));
  const drained = join(scratch, '.supervisor-drained');
  const env = { ...process.env, ELEVENEX_TASK_APP_RUNTIME_DIR: scratch, ELEVENEX_TASK_APP_DRAIN_PROOF: '1' };
  const options = { env, stdio: ['pipe', 'ignore', 'inherit', 'pipe', 'pipe'] };
  try {
    writeFileSync(drained, '', { mode: 0o600, flag: 'wx' });
    const marker = join(scratch, 'app-started');
    const cancelled = spawn(executable, ['--launch', '/usr/bin/touch', marker], options);
    const stopped = once(cancelled, 'exit');
    cancelled.stdin.end();
    await stopped;
    assert.equal(existsSync(marker), false, 'EOF before durable launch must leave the app unstarted');
    assert.equal(existsSync(drained), true);

    const child = spawn(executable, ['--launch', '/bin/sh', '-c', 'sleep 30 & exit 0'], options);
    const closed = once(child, 'exit');
    const deadline = setTimeout(() => child.kill('SIGKILL'), 8000);
    try {
      child.stdin.write('GO\n');
      const [bytes] = await once(child.stdio[3], 'data');
      const { group } = JSON.parse(bytes.toString());
      assert.ok(Number.isInteger(group) && group > 1);
      await new Promise(resolve => setTimeout(resolve, 350));
      assert.equal(child.exitCode, null, 'owned descendants keep a run alive');
      assert.equal(existsSync(drained), false);
      process.kill(-group, 0);
      child.stdin.end();
      const [code] = await closed;
      assert.equal(code, 0);
      assert.throws(() => process.kill(-group, 0), { code: 'ESRCH' });
      assert.equal(existsSync(drained), true, 'the next engine can confirm the process group drained');
    } finally {
      clearTimeout(deadline);
      child.stdin.end();
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

module.exports = { testMacSupervisor };
