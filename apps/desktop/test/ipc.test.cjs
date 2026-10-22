const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const vm = require('node:vm');

test('backend IPC validates the sender and all zero-argument operations, and cleans up events', async () => {
  const handlers = new Map();
  const events = [];
  const window = { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: (...args) => events.push(args) } };
  const ipcExports = {};
  vm.runInNewContext(await readFile(require.resolve('../dist/ipc'), 'utf8'), {
    exports: ipcExports,
    require: name => {
      assert.equal(name, 'electron');
      return { ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }, BrowserWindow: { getAllWindows: () => [window] } };
    },
  });
  const backendExports = {};
  vm.runInNewContext(await readFile(require.resolve('../dist/backend/ipc'), 'utf8'), {
    exports: backendExports, require: () => ipcExports,
  });
  const status = { phase: 'checking', version: null };
  let listener;
  let cleaned = false;
  const manager = {
    snapshot: () => status, start: async () => status, restart: async () => status,
    subscribe: fn => { listener = fn; return () => { cleaned = true; }; },
  };
  const frame = {};
  const sender = {};
  const stop = backendExports.registerBackendIpc(manager, (candidate, contents) => candidate === frame && contents === sender);
  for (const handler of handlers.values()) {
    assert.throws(() => handler({ senderFrame: {}, sender }), /Untrusted/);
    assert.throws(() => handler({ senderFrame: frame, sender }, 'unexpected'), /no arguments/);
    assert.deepEqual(await handler({ senderFrame: frame, sender }), status);
  }
  listener(status);
  assert.deepEqual(events, [['backend:changed', status]]);
  stop();
  assert.equal(cleaned, true);
});
