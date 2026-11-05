const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { BrowserWindow } = require('electron');
const { BackendClient } = require('../dist/backend-client/client');
const { TaskBrowser } = require('../dist/browser/task');
const { BrowserPersistence } = require('../dist/browser/persistence');
const { BrowserTaskProfiles } = require('../dist/browser/task-session');

/** Real task owner and Electron profiles; blank tabs start no page or network process. */
module.exports = async function browserOrderSmoke() {
  const root = await mkdtemp(join(tmpdir(), 'elevenex-tab-order-'));
  const source = new BrowserWindow({ show: false }), companion = new BrowserWindow({ show: false });
  const client = new BackendClient(() => ({ identity: 'tab-order', url: 'http://127.0.0.1:11111', version: 'a'.repeat(40), headers: {}, environment: { kind: 'local' } }), () => undefined);
  client.attach(source.webContents.id);
  const scope = client.state(source.webContents.id).scope.id;
  const persistence = new BrowserPersistence(root), profiles = new BrowserTaskProfiles();
  const browser = new TaskBrowser(scope, 1, source, client, {}, persistence, randomUUID(), profiles, false, () => undefined, () => true);
  const ids = () => browser.snapshot().tabs.map(tab => tab.id);
  try {
    for (let i = 0; i < 3; i++) await browser.command({ kind: 'new-tab' });
    const [first, second, third] = ids(), initial = browser.snapshot();
    await browser.command({ kind: 'move-tab', tabId: third, beforeTabId: first });
    assert.deepEqual(ids(), [third, first, second]);
    assert.equal(browser.snapshot().active, initial.active);
    assert.deepEqual(browser.snapshot().tabs.find(tab => tab.id === third), initial.tabs.find(tab => tab.id === third));
    await assert.rejects(() => browser.command({ kind: 'move-tab', tabId: first, beforeTabId: randomUUID() }));
    assert.deepEqual(ids(), [third, first, second]);
    // A newly arriving tab survives a move based on previously known identities.
    const added = (await browser.command({ kind: 'new-tab' })).active;
    await browser.command({ kind: 'move-tab', tabId: third, beforeTabId: null });
    assert.deepEqual(ids(), [first, second, added, third]);
    for (let i = ids().length; i < 12; i++) await browser.command({ kind: 'new-tab' });
    const fullOrder = ids();
    browser.detachTab(second, companion);
    assert.deepEqual(ids(), fullOrder, 'Detaching preserves position at the tab limit');
    assert.equal(browser.snapshot().tabs.find(tab => tab.id === second).detached, true);
    browser.returnTab(second);
    assert.deepEqual(ids(), fullOrder, 'Returning preserves position at the tab limit');
    assert.equal(browser.snapshot().tabs.find(tab => tab.id === second).detached, false);
    await assert.rejects(() => browser.command({ kind: 'new-tab' }));
    await browser.command({ kind: 'close', tabId: second });
    await assert.rejects(() => browser.command({ kind: 'move-tab', tabId: second, beforeTabId: null }));
    assert.deepEqual(ids(), fullOrder.filter(id => id !== second));
    const restored = new TaskBrowser(scope, 2, source, client, {}, {
      read: async () => ({ active: 0, tabs: [
        { url: 'https://one.example/', width: 'full' },
        { url: 'https://two.example/', width: 'phone' },
      ] }), save: () => undefined,
    }, randomUUID(), profiles, false, () => undefined, () => true);
    try {
      await restored.restore();
      const initial = restored.snapshot(), next = initial.tabs[1];
      await restored.command({ kind: 'close', tabId: initial.active });
      assert.equal(restored.snapshot().active, next.id);
      assert.equal(restored.snapshot().tabs[0].loading, true);
      assert.equal(restored.surfaces().some(surface => surface.tabId === next.id), true, 'Closing the active restored tab must start the newly selected lazy page');
    } finally { restored.destroy(); }
  } finally {
    browser.destroy(); client.dispose(); source.destroy(); companion.destroy();
    await Promise.all([persistence.flush(), profiles.flush()]);
    await rm(root, { recursive: true, force: true });
  }
  console.log('Browser ordering smoke passed: stable moves, concurrent tabs, invalid anchors, and detach/return at the tab limit.');
};
