// Run with Electron after building. This exercises the real sandboxed preload
// and app:// handler, rather than Node mocks. Not part of the headless unit suite.
const { app, BrowserWindow, Menu, nativeTheme } = require('electron');
const assert = require('node:assert/strict');

const timeout = setTimeout(() => { console.error('Electron smoke test timed out'); app.exit(1); }, 30000);
function nextWindow() {
  return new Promise((resolve, reject) => {
    app.once('browser-window-created', (_event, window) => {
      window.webContents.once('did-finish-load', () => resolve(window));
      window.webContents.once('did-fail-load', (_event, code, message) => reject(new Error(`${code}: ${message}`)));
    });
  });
}
const firstWindow = nextWindow();
require('../dist/main.js');

void (async () => {
  const window = await firstWindow;
  const prefs = window.webContents.getLastWebPreferences();
  assert.equal(prefs.contextIsolation, true);
  assert.equal(prefs.nodeIntegration, false);
  assert.equal(prefs.sandbox, true);
  const bridge = await window.webContents.executeJavaScript(`(async () => ({
    node: typeof require,
    keys: Object.keys(window.elevenex).sort(),
    version: await window.elevenex.appVersion(),
    status: await window.elevenex.gitStatus('/mock/workspace'),
    invalidRejected: await window.elevenex.gitStatus('').then(() => false, () => true),
  }))()`);
  assert.equal(bridge.node, 'undefined');
  assert.deepEqual(bridge.keys, ['appVersion', 'gitStatus', 'onThemeChanged', 'platform']);
  assert.equal(typeof bridge.version, 'string');
  assert.deepEqual(bridge.status, { path: '/mock/workspace', branch: 'main', staged: [], modified: ['README.md'], untracked: [], mock: true });
  assert.equal(bridge.invalidRejected, true);

  await window.webContents.executeJavaScript('window.smokeThemeReady = new Promise(resolve => { window.smokeUnsubscribe = window.elevenex.onThemeChanged(resolve); }); void 0;');
  const theme = nativeTheme.shouldUseDarkColors ? 'light' : 'dark';
  const updated = new Promise((resolve) => nativeTheme.once('updated', resolve));
  nativeTheme.themeSource = theme;
  await updated;
  assert.equal(await window.webContents.executeJavaScript('window.smokeThemeReady'), theme);
  await window.webContents.executeJavaScript('window.smokeUnsubscribe()');
  nativeTheme.themeSource = 'system';

  const secondWindow = nextWindow();
  const newWindow = Menu.getApplicationMenu().items.find(item => item.label === 'File').submenu.items.find(item => item.label === 'New Window');
  assert.equal(newWindow.accelerator, 'CmdOrCtrl+Shift+N');
  newWindow.click();
  const second = await secondWindow;
  assert.equal(BrowserWindow.getAllWindows().length, 2);
  second.destroy();

  await window.loadURL('app://elevenex/smoke/history');
  assert.equal(window.webContents.getURL(), 'app://elevenex/smoke/history');
  assert.equal(await window.webContents.executeJavaScript('typeof window.elevenex.gitStatus'), 'function');
  const assets = await window.webContents.executeJavaScript(`(async () => {
    const index = await fetch('/');
    const missing = await fetch('/missing-asset.js');
    return { csp: index.headers.get('Content-Security-Policy'), missing: missing.status };
  })()`);
  assert.ok(assets.csp.includes("script-src 'self'"));
  assert.ok(!assets.csp.includes('unsafe-inline'));
  assert.equal(assets.missing, 404);
  console.log('Electron smoke passed: sandbox, typed IPC, runtime validation, native theme, multiple windows and app:// history/CSP.');
  clearTimeout(timeout);
  app.quit();
})().catch((error) => {
  console.error(error);
  clearTimeout(timeout);
  app.exit(1);
});
