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

test('remote IPC derives window ownership from the trusted sender, validates arity and removes handlers', async () => {
  const handlers = new Map(); const removed = []; const calls = [];
  const ipcExports = {};
  vm.runInNewContext(await readFile(require.resolve('../dist/ipc'), 'utf8'), {
    exports: ipcExports, require: () => ({ ipcMain: {
      handle: (channel, handler) => handlers.set(channel, handler), removeHandler: channel => removed.push(channel),
    } }),
  });
  const remoteExports = {};
  vm.runInNewContext(await readFile(require.resolve('../dist/remote/ipc'), 'utf8'), {
    exports: remoteExports, require: name => {
      if (name === '../ipc') return ipcExports;
      if (name === './validation') return require('../dist/remote/validation');
      if (name === 'electron') return {
        BrowserWindow: { getAllWindows: () => [{ webContents: { id: 42 }, isDestroyed: () => false }] },
        dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: ['/chosen/identity'] }) },
      };
      return require(name);
    },
  });
  const manager = new Proxy({}, { get: (_target, method) => (...args) => { calls.push([method, ...args]); return 'snapshot'; } });
  const frame = {}; const sender = { id: 42 };
  const stop = remoteExports.registerRemoteIpc(manager, { snapshot: () => ({ phase: 'idle', version: null }) }, (candidate, contents) => candidate === frame && contents === sender);
  for (const [, channel, args] of require('./remote-contract.cjs').calls) {
    const handler = handlers.get(channel); assert.ok(handler, channel);
    assert.throws(() => handler({ senderFrame: {}, sender }, ...args), /Untrusted/);
    assert.throws(() => handler({ senderFrame: frame, sender }, ...args, 'extra'), /Unexpected/);
    await handler({ senderFrame: frame, sender }, ...args);
  }
  assert.ok(calls.some(call => call[0] === 'disconnect' && call[1] === 42));
  assert.ok(calls.some(call => call[0] === 'answer' && call[1] === 42));
  assert.ok(calls.some(call => call[0] === 'grantFile' && call[1] === 'identity' && call[2] === '/chosen/identity'));
  stop(); assert.deepEqual(removed.sort(), [...handlers.keys()].sort());
});
