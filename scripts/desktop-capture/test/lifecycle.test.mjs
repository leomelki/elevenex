import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { tmpdir } from 'node:os';
import { CaptureProcesses } from '../processes.mjs';
import { CaptureConnection } from '../connection.mjs';
import { CaptureMotion } from '../motion.mjs';

class DebuggerFixture extends EventEmitter {
  attached = false;
  attach() { this.attached = true; }
  detach() { this.attached = false; }
  isAttached() { return this.attached; }
  async sendCommand() {}
}

test('disposing motion leaves diagnostics active until the owning connection closes', async () => {
  const debuggerConnection = new DebuggerFixture();
  const report = { errors: [], warnings: [], droppedDiagnostics: 0 };
  const connection = new CaptureConnection(debuggerConnection, report);
  const commands = [];
  const page = { cdp: async (...args) => commands.push(args), settle: async () => {} };
  const motion = new CaptureMotion(page, debuggerConnection);
  debuggerConnection.emit('message', null, 'Animation.animationStarted', { animation: { id: 'cancelled' } });
  debuggerConnection.emit('message', null, 'Animation.animationCanceled', { id: 'cancelled' });
  await assert.rejects(() => motion.seek(100), /No tracked animations/);
  debuggerConnection.emit('message', null, 'Animation.animationStarted', { animation: { id: 'active' } });
  await motion.seek(100);
  assert.deepEqual(commands.at(-1), ['Animation.seekAnimations', { animations: ['active'], currentTime: 100 }]);

  motion.dispose();
  debuggerConnection.emit('message', null, 'Runtime.exceptionThrown', { exceptionDetails: { text: 'Observed after motion disposal' } });
  assert.deepEqual(report.errors, ['Observed after motion disposal']);
  assert.equal(debuggerConnection.isAttached(), true);

  connection.dispose();
  connection.dispose();
  assert.equal(debuggerConnection.isAttached(), false);
  assert.equal(debuggerConnection.listenerCount('message'), 0);
  debuggerConnection.emit('message', null, 'Runtime.exceptionThrown', { exceptionDetails: { text: 'Must be ignored' } });
  assert.equal(report.errors.length, 1);
});

test('diagnostic overflow remains bounded and counted', () => {
  const debuggerConnection = new DebuggerFixture();
  const report = { errors: [], warnings: [], droppedDiagnostics: 0 };
  const connection = new CaptureConnection(debuggerConnection, report);
  try {
    for (let i = 0; i < 205; i++) debuggerConnection.emit('message', null, 'Network.loadingFailed', { errorText: 'Request failed', type: 'Fetch' });
    assert.equal(report.errors.length, 200);
    assert.equal(report.droppedDiagnostics, 5);
  } finally { connection.dispose(); }
});

test('process shutdown is idempotent and leaves another owner running', { timeout: 5000 }, async t => {
  const first = new CaptureProcesses();
  const other = new CaptureProcesses();
  t.after(async () => { await Promise.all([first.stop(), other.stop()]); });
  const owned = first.start(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], tmpdir());
  const unrelated = other.start(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], tmpdir());
  await Promise.all([once(owned.child, 'spawn'), once(unrelated.child, 'spawn')]);
  const stopped = first.stop();
  assert.equal(first.stop(), stopped);
  await stopped;
  assert.notEqual(owned.child.signalCode, null);
  assert.equal(unrelated.child.exitCode, null);
  assert.equal(unrelated.child.signalCode, null);
  assert.throws(() => first.start(process.execPath, [], tmpdir()), /stopped/);
});

test('a failed spawn cannot hang owner cleanup', { timeout: 2000 }, async () => {
  const processes = new CaptureProcesses();
  const child = processes.start('/elevenex-capture/nonexistent-executable', [], tmpdir());
  const stopped = processes.stop();
  await assert.rejects(child.done, /ENOENT/);
  await stopped;
});
