// Run with Electron after building. This exercises the real sandboxed preload
// and app:// handler, rather than Node mocks. Not part of the headless unit suite.
const { app, BrowserWindow, Menu, nativeTheme } = require('electron');
const assert = require('node:assert/strict');
const { mkdtempSync } = require('node:fs');
const { rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { BackendManager } = require('../dist/backend/manager');
const { backendRelease } = require('../dist/backend/release');
const remoteContract = require('./remote-contract.cjs');

// Replace only the composition boundary in this test process. Native IPC and
// preload are real; download/process behavior has separate integration tests.
// No test hooks, fixture paths or switches enter the production bridge.
const backendRoot = mkdtempSync(join(tmpdir(), 'elevenex-electron-backend-'));
app.setPath('appData', backendRoot);
const revision = 'a'.repeat(40);
require('../dist/backend/application').createApplicationBackend = () => new BackendManager({
  root: backendRoot,
  release: async () => backendRelease({ version: revision, tag: `runtime-${revision}` }, process.platform, process.arch),
  install: async () => ({ directory: backendRoot, entry: '', executable: '' }),
  start: async () => {
    let stopped;
    const exited = new Promise(resolve => { stopped = resolve; });
    return { url: 'http://127.0.0.1:12345', exited, stop: async () => stopped({ code: 0, signal: null }) };
  },
});

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
    backend: await window.elevenex.retryBackend(),
  }))()`);
  assert.equal(bridge.node, 'undefined');
  assert.deepEqual(bridge.keys, ['appVersion', 'backendStatus', 'gitStatus', 'onBackendChanged', 'onThemeChanged', 'platform', 'restartBackend', 'retryBackend', ...remoteContract.methods].sort());
  assert.equal(typeof bridge.version, 'string');
  assert.deepEqual(bridge.status, { path: '/mock/workspace', branch: 'main', staged: [], modified: ['README.md'], untracked: [], mock: true });
  assert.equal(bridge.invalidRejected, true);
  assert.deepEqual(bridge.backend, { phase: 'ready', version: revision, url: 'http://127.0.0.1:12345' });
  const remote = await window.webContents.executeJavaScript(`(async () => {
    const hosts = await window.elevenex.remoteHosts();
    const state = await window.elevenex.environmentStatus();
    const invalid = await window.elevenex.saveRemoteHost({name:'bad',host:'-oProxyCommand=evil'},null).then(()=>false,()=>true);
    await window.elevenex.saveEnvironmentContext({projectId:null,taskId:2,sessionId:3,draft:'unsent',cursor:'cursor'}, {kind:'local'});
    return {hosts,state,invalid};
  })()`);
  assert.deepEqual(remote.hosts, []); assert.equal(remote.state.selection.kind, 'local'); assert.equal(remote.invalid, true);
  await window.webContents.executeJavaScript(`window.smokeBackendReady = new Promise(resolve => {
    window.smokeBackendUnsubscribe = window.elevenex.onBackendChanged(status => { if (status.phase === 'ready') resolve(status); });
  }); void 0;`);
  await window.webContents.executeJavaScript('window.elevenex.restartBackend()');
  assert.equal((await window.webContents.executeJavaScript('window.smokeBackendReady')).phase, 'ready');
  await window.webContents.executeJavaScript('window.smokeBackendUnsubscribe()');

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
  assert.equal((await second.webContents.executeJavaScript('window.elevenex.environmentStatus()')).context.draft, '');
  assert.equal((await window.webContents.executeJavaScript('window.elevenex.environmentStatus()')).context.draft, 'unsent');
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
  console.log('Electron smoke passed: sandbox, typed backend lifecycle IPC/events, runtime validation, native theme, multiple windows and app:// history/CSP. Backend runtime is a test fixture.');
  await rm(backendRoot, { recursive: true, force: true });
  clearTimeout(timeout);
  app.quit();
})().catch((error) => {
  console.error(error);
  clearTimeout(timeout);
  app.exit(1);
});
