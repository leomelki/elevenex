const assert = require('node:assert/strict');
const { BrowserWindow, webContents, nativeTheme } = require('electron');
const { setTimeout: delay } = require('node:timers/promises');
async function until(check, message) { const end = Date.now() + 10000; while (Date.now() < end) { const result = await check(); if (result) return result; await delay(30); } throw new Error(message); }

/** Real app:// companion, native guests, narrow preload, and one task profile. */
module.exports = async function detachedBrowserSmoke(source, original, scope, tabId) {
  const context = { projectName: 'Elevenex', taskName: 'Polish checkout flow', branchName: 'feat/checkout', machineName: 'This Mac', stage: 'active', hue: 'ocean' };
  const call = (window, method, ...args) => window.webContents.executeJavaScript(`window.elevenex.${method}(...${JSON.stringify(args)})`);
  const profile = original.session, url = original.getURL();
  const theme = nativeTheme.shouldUseDarkColors ? 'light' : 'dark';
  await call(source, 'taskBrowserCommand', scope, 1, { kind: 'theme', tabId, theme });
  await call(source, 'taskBrowserCommand', scope, 1, { kind: 'network', tabId, slow: true });
  const assertSettings = async (window, guest) => {
    const tab = (await call(window, 'taskBrowserRead', scope, 1)).value.tabs.find(tab => tab.id === tabId);
    assert.equal(tab.theme, theme); assert.equal(tab.slowNetwork, true);
    assert.equal(await guest.executeJavaScript("matchMedia('(prefers-color-scheme: dark)').matches"), theme === 'dark', 'Rehost must restore the actual page theme');
    const elapsed = await guest.executeJavaScript(`(async () => { const start = performance.now(); await fetch(${JSON.stringify(url + '?network-probe')}, {cache:'no-store'}).then(response => response.text()); return performance.now() - start; })()`);
    assert.ok(elapsed >= 100, 'Rehost must restore slow network emulation: ' + elapsed);
  };
  await profile.cookies.set({ url, name: 'window-profile', value: 'retained' });
  const sourceReady = async () => {
    const state = (await call(source, 'taskBrowserRead', scope, 1)).value, tab = state.tabs.find(tab => tab.id === tabId);
    if (!tab || tab.loading || tab.error) return false;
    await call(source, 'taskBrowserLayout', scope, 1, { sequence: Math.floor(performance.now() * 1000), surfaceEpoch: state.surfaceEpoch, ownerGeneration: tab.generation, inputReady: true, visible: true, reducedMotion: false, bounds: { x: 400, y: 200, width: 390, height: 350 } });
    return (await call(source, 'taskBrowserRead', scope, 1)).value.tabs.find(tab => tab.id === tabId)?.ready;
  };
  const page = () => webContents.getAllWebContents().find(contents => contents.getType() === 'webview' && contents.getURL() === url && contents.session === profile);
  await call(source, 'taskBrowserDetach', scope, 1, tabId, context);
  const companion = await until(() => BrowserWindow.getAllWindows().find(window => window !== source && window.webContents.getURL() === 'app://elevenex/browser-window'), 'Companion window was not created');
  let otherId;
  try {
    await until(() => companion.webContents.executeJavaScript('!!document.querySelector("ex-browser-window ex-task-browser .native-page")'), 'Companion route did not mount');
    await until(async () => (await call(companion, 'taskBrowserRead', scope, 1)).value.tabs[0]?.ready, 'Companion native page is not interactive');
    const guest = await until(page, 'Native guest did not open in companion');
    await assertSettings(companion, guest);
    // Agent downloads require the user and create a notice owned by this tab.
    await call(companion, 'taskBrowserCommand', scope, 1, { kind: 'handoff', tabId, sessionId: 2 });
    await guest.executeJavaScript('location.href=' + JSON.stringify(new URL('/download-test', url).href));
    await until(async () => (await call(companion, 'taskBrowserRead', scope, 1)).value.attention?.tabId === tabId, 'Download notice did not appear');
    assert.equal((await call(companion, 'taskBrowserCommand', scope, 1, { kind: 'dismiss-attention' })).ok, true);
    assert.equal((await call(companion, 'taskBrowserRead', scope, 1)).value.attention, undefined);
    assert.equal(original.isDestroyed(), true, 'Local rehosting intentionally reloads the document');
    assert.equal(guest.session, profile);
    assert.equal((await profile.cookies.get({ url, name: 'window-profile' }))[0].value, 'retained');
    assert.deepEqual(await guest.executeJavaScript('({node:typeof require,bridge:typeof window.elevenex})'), { node: 'undefined', bridge: 'undefined' });
    assert.equal((await call(companion, 'taskBrowserWindow')).tabId, tabId);
    assert.equal((await call(companion, 'taskBrowserRead', scope, 1)).value.tabs.length, 1);
    assert.equal((await call(source, 'taskBrowserRead', scope, 1)).value.tabs.find(tab => tab.id === tabId).detached, true);
    assert.equal((await call(companion, 'taskBrowserRead', scope, 999)).ok, false);
    assert.equal((await call(companion, 'taskBrowserCommand', scope, 1, {kind:'new-tab'})).ok, false);
    const other = await call(source, 'taskBrowserCommand', scope, 1, {kind:'new-tab'});
    assert.equal(other.ok, true); assert.notEqual(other.value.active, tabId); otherId = other.value.active;
    assert.equal((await call(companion, 'taskBrowserRead', scope, 1)).value.active, tabId);
    assert.equal((await call(companion, 'taskBrowserRead', scope, 1)).value.tabs.length, 1);
    const outside = await call(source, 'taskBrowserCommand', scope, 1, { kind: 'navigate', tabId: otherId, url: url + '?other-notice' });
    assert.equal(outside.ok, true);
    const otherGuest = await until(() => webContents.getAllWebContents().find(contents => contents.getURL() === url + '?other-notice'), 'Other tab did not load');
    await until(async () => !(await call(source, 'taskBrowserRead', scope, 1)).value.tabs.find(tab => tab.id === otherId)?.loading, 'Other tab is still loading');
    const otherState = (await call(source, 'taskBrowserRead', scope, 1)).value;
    await call(source, 'taskBrowserLayout', scope, 1, { sequence: Math.floor(performance.now() * 1000), surfaceEpoch: otherState.surfaceEpoch, ownerGeneration: otherState.tabs.find(tab => tab.id === otherId).generation, inputReady: true, visible: true, reducedMotion: false, bounds: { x: 400, y: 200, width: 390, height: 350 } });
    await call(source, 'taskBrowserCommand', scope, 1, { kind: 'handoff', tabId: otherId, sessionId: 2 });
    await otherGuest.executeJavaScript('location.href=' + JSON.stringify(new URL('/download-test', url).href));
    await until(async () => (await call(source, 'taskBrowserRead', scope, 1)).value.attention?.tabId === otherId, 'Other tab notice did not appear');
    assert.equal((await call(companion, 'taskBrowserCommand', scope, 1, { kind: 'dismiss-attention' })).ok, false, 'A companion cannot dismiss another tab’s notice');
    await call(source, 'taskBrowserCommand', scope, 1, { kind: 'dismiss-attention' });
    await assert.rejects(() => call(companion, 'taskBrowserInput', scope, 1, otherId, 1, {kind:'text',text:'forbidden'}));
    await source.webContents.executeJavaScript('document.body.style.display="none"');
    await until(async () => (await call(companion, 'taskBrowserRead', scope, 1)).value.tabs[0].ready, 'Companion lost authority when the main view hid');
    const viewport = await guest.executeJavaScript('({width:innerWidth,height:innerHeight})');
    assert.ok(viewport.width > 600 && viewport.height > 300, JSON.stringify(viewport));
    await guest.executeJavaScript('document.querySelector("input").value="private-in-window"');
    assert.equal(JSON.stringify((await call(companion, 'taskBrowserRead', scope, 1)).value).includes('private-in-window'), false);
  } finally {
    if (!source.isDestroyed()) await source.webContents.executeJavaScript('document.body.style.display=""');
    if (!companion.isDestroyed()) companion.close();
  }
  await call(source, 'taskBrowserCommand', scope, 1, {kind:'select',tabId});
  await until(sourceReady, 'Native close did not return a working page');
  if (otherId) await call(source, 'taskBrowserCommand', scope, 1, {kind:'close',tabId:otherId});
  await call(source, 'taskBrowserDetach', scope, 1, tabId, context);
  const reopened = await until(() => BrowserWindow.getAllWindows().find(window => window !== source && window.webContents.getURL() === 'app://elevenex/browser-window'), 'Companion did not reopen');
  await until(() => reopened.webContents.executeJavaScript('!!document.querySelector("ex-browser-window")'), 'Reopened route did not mount');
  await call(reopened, 'taskBrowserWindowAction', 'return').catch(error => { if (!reopened.isDestroyed() && !String(error).includes('Render frame was disposed')) throw error; });
  await until(() => reopened.isDestroyed(), 'Return action did not close companion');
  const returned = await until(async () => { const contents = page(); return contents && await sourceReady() ? contents : null; }, 'Explicit return did not restore a working native page');
  assert.equal(returned.session, profile);
  await assertSettings(source, returned);
  await call(source, 'taskBrowserCommand', scope, 1, { kind: 'network', tabId, slow: false });
  await call(source, 'taskBrowserCommand', scope, 1, { kind: 'theme', tabId, theme: 'system' });
  console.log('Browser smoke: native detach/return, shared profile, hidden source, tab isolation and native close passed');
  return returned;
};
