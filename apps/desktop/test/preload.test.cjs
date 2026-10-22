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
          removeListener: (channel, fn) => { assert.equal(listeners.get(channel), fn); listeners.delete(channel); },
        },
      };
    },
  });
  assert.deepEqual(Object.keys(bridge).sort(), ['appVersion', 'backendStatus', 'gitStatus', 'onBackendChanged', 'onThemeChanged', 'platform', 'restartBackend', 'retryBackend']);
  assert.equal(Object.isFrozen(bridge), true);
  await bridge.appVersion();
  await bridge.gitStatus('/workspace');
  await bridge.backendStatus();
  await bridge.retryBackend();
  await bridge.restartBackend();
  assert.deepEqual(calls, [['app:version'], ['git:status', '/workspace'], ['backend:status'], ['backend:retry'], ['backend:restart']]);
  const received = [];
  const stop = bridge.onThemeChanged((...args) => received.push(args));
  listeners.get('theme:changed')({ sender: 'private Electron object' }, 'dark');
  assert.deepEqual(received, [['dark']]);
  stop();
  const stopBackend = bridge.onBackendChanged((...args) => received.push(args));
  listeners.get('backend:changed')({ sender: 'private Electron object' }, { phase: 'starting', version: 'abc' });
  assert.deepEqual(received[1], [{ phase: 'starting', version: 'abc' }]);
  stopBackend();
  assert.equal(listeners.size, 0);
});
