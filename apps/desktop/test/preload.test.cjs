const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const vm = require('node:vm');
const remote = require('./remote-contract.cjs');
const machines = require('./machine-contract.cjs');
const workspace = require('./workspace-contract.cjs');
const chatMethods = ['sessionChatCatalog', 'sessionChatChanges', 'sessionChatRead', 'sessionChatCommand', 'sessionChatCancel', 'sessionChatContent'];

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
          removeListener: (channel, fn) => {
            assert.equal(listeners.get(channel), fn); listeners.delete(channel);
            return { privateElectronEmitter: true };
          },
        },
      };
    },
  });
  assert.deepEqual(Object.keys(bridge).sort(), ['appVersion', 'backendStatus', 'gitStatus', 'onBackendChanged', 'onThemeChanged', 'platform', 'restartBackend', 'retryBackend', 'backendClientState', 'backendInfo', 'onBackendClientChanged', ...remote.methods, ...machines.methods, ...workspace.methods, ...chatMethods].sort());
  assert.equal(Object.isFrozen(bridge), true);
  await bridge.appVersion();
  await bridge.gitStatus('/workspace');
  await bridge.backendStatus();
  await bridge.retryBackend();
  await bridge.restartBackend();
  assert.deepEqual(calls, [['app:version'], ['git:status', '/workspace'], ['backend:status'], ['backend:retry'], ['backend:restart']]);
  calls.length = 0;
  await bridge.backendClientState();
  await bridge.backendInfo('scope');
  assert.deepEqual(calls, [['backend-client:state'], ['backend-client:info', 'scope']]);
  calls.length = 0;
  for (const [method, , args] of remote.calls) await bridge[method](...args);
  assert.deepEqual(calls, remote.calls.map(([, channel, args]) => [channel, ...args]));
  calls.length = 0;
  for (const [method, , args] of machines.calls) await bridge[method](...args);
  assert.deepEqual(calls, machines.calls.map(([, channel, args]) => [channel, ...args]));
  calls.length = 0;
  for (const [method, , args] of workspace.calls) await bridge[method](...args);
  assert.deepEqual(calls, workspace.calls.map(([, channel, args]) => [channel, ...args]));
  calls.length = 0;
  const target = { taskId: 1, sessionId: 2, requestId: 'read' };
  await bridge.sessionChatChanges('scope', { ...target, turnId: 'reply', offset: 0 });
  await bridge.sessionChatCatalog('scope', { ...target, provider: 'claude' });
  await bridge.sessionChatRead('scope', target);
  await bridge.sessionChatContent('scope', { ...target, itemId: 'item', part: 'text', offset: 0 });
  await bridge.sessionChatCommand('scope', { taskId: 1, sessionId: 2, action: { type: 'stop' } });
  await bridge.sessionChatCancel('scope', 'read');
  assert.deepEqual(calls, [['session-chat:changes', 'scope', { ...target, turnId: 'reply', offset: 0 }], ['session-chat:catalog', 'scope', { ...target, provider: 'claude' }], ['session-chat:read', 'scope', target], ['session-chat:content', 'scope', { ...target, itemId: 'item', part: 'text', offset: 0 }], ['session-chat:command', 'scope', { taskId: 1, sessionId: 2, action: { type: 'stop' } }], ['session-chat:cancel', 'scope', 'read']]);
  calls.length = 0;
  await bridge.workspaceRetryTask('scope', 1, 'use-existing');
  await bridge.workspaceRetryTask('scope', 1, 'snapshot');
  assert.deepEqual(calls, [['workspace:retry-task', 'scope', 1, 'use-existing'], ['workspace:retry-task', 'scope', 1, 'snapshot']]);
  const received = [];
  const stop = bridge.onThemeChanged((...args) => received.push(args));
  listeners.get('theme:changed')({ sender: 'private Electron object' }, 'dark');
  assert.deepEqual(received, [['dark']]);
  assert.equal(stop(), undefined, 'cleanup must not return an Electron emitter across the bridge');
  const stopBackend = bridge.onBackendChanged((...args) => received.push(args));
  listeners.get('backend:changed')({ sender: 'private Electron object' }, { phase: 'starting', version: 'abc' });
  assert.deepEqual(received[1], [{ phase: 'starting', version: 'abc' }]);
  stopBackend();
  const stopRemote = bridge.onEnvironmentChanged((...args) => received.push(args));
  const snapshot = { selection: { kind: 'local' } };
  listeners.get('environment:changed')({ sender: 'private object' }, snapshot);
  assert.deepEqual(received.at(-1), [snapshot]); stopRemote();
  const clientState = { revision: 1, scope: null };
  const stopClient = bridge.onBackendClientChanged((...args) => received.push(args));
  listeners.get('backend-client:changed')({ sender: 'private object' }, clientState);
  assert.deepEqual(received.at(-1), [clientState]); stopClient();
  const stopMachine = bridge.onMachineStateChanged((...args) => received.push(args));
  listeners.get('machines:changed')({ sender: 'private object' }, { revision: 4 });
  assert.deepEqual(received.at(-1), [{ revision: 4 }]); stopMachine();
  assert.equal(listeners.size, 0);
});
