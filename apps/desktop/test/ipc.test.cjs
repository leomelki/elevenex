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

test('backend client IPC validates scope/arity, isolates window ownership and unregisters handlers', async () => {
  const handlers = new Map(); const calls = [];
  const ipcExports = {};
  vm.runInNewContext(await readFile(require.resolve('../dist/ipc'), 'utf8'), {
    exports: ipcExports, require: () => ({ ipcMain: {
      handle: (channel, handler) => handlers.set(channel, handler), removeHandler: channel => handlers.delete(channel),
    } }),
  });
  const clientExports = {};
  vm.runInNewContext(await readFile(require.resolve('../dist/backend-client/ipc'), 'utf8'), {
    exports: clientExports, require: () => ipcExports,
  });
  const frame = {}; const sender = { id: 42 };
  const client = { state: id => calls.push(['state', id]), info: (...args) => calls.push(['info', ...args]) };
  const stop = clientExports.registerBackendClientIpc(client, (candidate, contents) => candidate === frame && contents === sender);
  const event = { senderFrame: frame, sender };
  const state = handlers.get('backend-client:state'); const info = handlers.get('backend-client:info');
  const scope = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  assert.throws(() => state({ senderFrame: {}, sender }), /Untrusted/);
  assert.throws(() => info({ senderFrame: {}, sender }, scope), /Untrusted/);
  assert.throws(() => state(event, 'extra'), /no arguments/);
  for (const args of [[], [42], [''], [{ url: 'http://evil' }], [scope, 'extra']]) assert.throws(() => info(event, ...args), /scope/);
  state(event); info(event, scope);
  assert.deepEqual(calls, [['state', 42], ['info', 42, scope]]);
  stop(); assert.equal(handlers.size, 0);
});

test('machine IPC verifies main-frame ownership, bounds suggestions and validates new-window selection', async () => {
  const handlers = new Map(); const calls = [];
  const ipcExports = {};
  vm.runInNewContext(await readFile(require.resolve('../dist/ipc'), 'utf8'), {
    exports: ipcExports, require: () => ({ ipcMain: {
      handle: (channel, handler) => handlers.set(channel, handler), removeHandler: channel => handlers.delete(channel),
    } }),
  });
  const machineExports = {};
  vm.runInNewContext(await readFile(require.resolve('../dist/machines/ipc'), 'utf8'), {
    exports: machineExports, require: name => {
      if (name === '../ipc') return ipcExports;
      if (name === '../remote/validation') return require('../dist/remote/validation');
      if (name === './ssh-hosts') return { sshHostSuggestions: (_path, query) => { calls.push(['suggestions', query]); return []; } };
      return require(name);
    },
  });
  const frame = {}, sender = { id: 42 }, event = { senderFrame: frame, sender };
  const machines = {
    edit: (...args) => calls.push(['edit', ...args]), disconnect: (...args) => calls.push(['disconnect', ...args]),
    remove: (...args) => calls.push(['remove', ...args]), undoRemove: (...args) => calls.push(['undo', ...args]), dismissRemoval: (...args) => calls.push(['dismiss', ...args]),
    snapshot: id => calls.push(['state', id]), opened: (id, selection) => calls.push(['opened', id, selection]),
    validateSelection: value => value === null ? null : require('../dist/remote/validation').selection(value),
  };
  const stop = machineExports.registerMachineIpc(machines, (candidate, contents) => candidate === frame && contents === sender, selection => calls.push(['window', selection]));
  for (const [, channel, args] of require('./machine-contract.cjs').calls) {
    const handler = handlers.get(channel); assert.ok(handler);
    assert.throws(() => handler({ senderFrame: {}, sender }, ...args), /Untrusted/);
    assert.throws(() => handler(event, ...args, 'extra'), /Unexpected/);
    await handler(event, ...args);
  }
  assert.ok(calls.some(call => call[0] === 'opened' && call[1] === 42));
  assert.throws(() => handlers.get('machines:new-window')(event, { kind: 'local', command: 'evil' }), /Invalid/);
  for (const query of ['x'.repeat(254), '\0', 42]) assert.throws(() => handlers.get('machines:ssh-hosts')(event, query), /Invalid/);
  stop(); assert.equal(handlers.size, 0);
});
