const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const vm = require('node:vm');

test('preload exposes only the typed bridge and strips event objects', async () => {
  let bridge;
  const calls = [];
  const listeners = new Map();
  const code = await readFile(require.resolve('../dist/preload.js'), 'utf8');
  vm.runInNewContext(code, {
    exports: {}, process: { platform: 'darwin' },
    require: (name) => {
      assert.equal(name, 'electron', 'sandbox preload must not import other modules');
      return {
        contextBridge: { exposeInMainWorld: (name, value) => { assert.equal(name, 'elevenex'); bridge = value; } },
        ipcRenderer: {
          invoke: async (...args) => { calls.push(args); return 'mock'; },
          on: (channel, fn) => listeners.set(channel, fn),
          removeListener: (channel, fn) => { assert.equal(listeners.get(channel), fn); listeners.delete(channel); return { privateEmitter: Symbol('ipcRenderer') }; },
        },
      };
    },
  });
  assert.deepEqual(Object.keys(bridge).sort(), ['appVersion', 'gitStatus', 'onThemeChanged', 'platform']);
  assert.equal(Object.isFrozen(bridge), true);
  await bridge.appVersion();
  await bridge.gitStatus('/workspace');
  assert.deepEqual(calls, [['app:version'], ['git:status', '/workspace']]);
  const received = [];
  const stop = bridge.onThemeChanged((...args) => received.push(args));
  listeners.get('theme:changed')({ sender: 'private Electron object' }, 'dark');
  assert.deepEqual(received, [['dark']]);
  assert.equal(stop(), undefined, 'unsubscribe must not return the private emitter across contextBridge');
  assert.equal(listeners.size, 0);
});
