const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const vm = require('node:vm');

test('compact presentation restores preferences after reload and only changes layout at mode boundaries', async () => {
  const values = new Map([['workbench.activityBar.location', 'top'], ['editor.wordWrap', 'bounded']]);
  const persisted = new Map(), calls = [], updates = [];
  const state = { get: key => globalThis.structuredClone(persisted.get(key)), update: async (key, value) => { persisted.set(key, globalThis.structuredClone(value)); } };
  const vscode = {
    ConfigurationTarget: { Global: 1 },
    workspace: { getConfiguration: () => ({ inspect: key => ({ globalValue: values.get(key) }), update: async (key, value, target) => { assert.equal(target, 1); values.set(key, value); updates.push(key); } }) },
    commands: { executeCommand: async (...args) => { calls.push(args); } },
  };
  const exports = {};
  vm.runInNewContext(await readFile(require.resolve('../dist/code/web/compact-layout.js'), 'utf8'), { exports, require: name => { assert.equal(name, 'vscode'); return vscode; } });
  const first = new exports.CompactLayout(state);
  await first.set(true); await first.set(true);
  assert.equal(updates.length, 2);
  assert.equal(values.get('workbench.activityBar.location'), 'hidden');
  assert.equal(values.get('editor.wordWrap'), 'on');
  assert.ok(calls.some(([command]) => command === 'workbench.action.closeSidebar'));
  const restored = new exports.CompactLayout(state);
  await restored.set(true); // Restarting while compact must not replace the journal.
  await restored.set(false);
  assert.equal(values.get('workbench.activityBar.location'), 'top');
  assert.equal(values.get('editor.wordWrap'), 'bounded');
  const count = updates.length;
  await restored.set(false);
  assert.equal(updates.length, count);
  assert.ok(calls.some(([command]) => command === 'workbench.view.explorer'));
});
