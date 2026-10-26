// Run with Electron after building. This exercises the real sandboxed preload
// and app:// handler, rather than Node mocks. Not part of the headless unit suite.
const { app, BrowserWindow, Menu, nativeTheme } = require('electron');
const assert = require('node:assert/strict');
const { mkdtempSync } = require('node:fs');
const { rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createServer } = require('node:http');
const { BackendManager } = require('../dist/backend/manager');
const { backendRelease } = require('../dist/backend/release');
const remoteContract = require('./remote-contract.cjs');
const machineContract = require('./machine-contract.cjs');

// Replace only the composition boundary in this test process. Native IPC and
// preload are real; download/process behavior has separate integration tests.
// No test hooks, fixture paths or switches enter the production bridge.
const backendRoot = mkdtempSync(join(tmpdir(), 'elevenex-electron-backend-'));
app.setPath('appData', backendRoot);
const revision = 'a'.repeat(40);
let backendUrl;
require('../dist/backend/application').createApplicationBackend = () => new BackendManager({
  root: backendRoot,
  release: async () => backendRelease({ version: revision, tag: `runtime-${revision}` }, process.platform, process.arch),
  install: async () => ({ directory: backendRoot, entry: '', executable: '' }),
  start: async () => {
    const http = createServer((request, response) => {
      assert.equal(request.url, '/api/info');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ backendSha: revision }));
    });
    await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
    backendUrl = `http://127.0.0.1:${http.address().port}`;
    let stopped;
    const exited = new Promise(resolve => { stopped = resolve; });
    return { url: backendUrl, exited, stop: async () => {
      await new Promise(resolve => { http.close(resolve); http.closeAllConnections(); });
      stopped({ code: 0, signal: null });
    } };
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
  assert.deepEqual(bridge.keys, ['appVersion', 'backendStatus', 'gitStatus', 'onBackendChanged', 'onThemeChanged', 'platform', 'restartBackend', 'retryBackend', 'backendClientState', 'backendInfo', 'onBackendClientChanged', ...remoteContract.methods, ...machineContract.methods].sort());
  assert.equal(typeof bridge.version, 'string');
  assert.deepEqual(bridge.status, { path: '/mock/workspace', branch: 'main', staged: [], modified: ['README.md'], untracked: [], mock: true });
  assert.equal(bridge.invalidRejected, true);
  assert.deepEqual(bridge.backend, { phase: 'ready', version: revision, url: backendUrl });
  const machine = await window.webContents.executeJavaScript('window.elevenex.machineState()');
  assert.equal(machine.hasOpenedMachine, false);
  assert.equal(machine.localBackend.phase, 'ready');
  const opened = await window.webContents.executeJavaScript('window.elevenex.markMachineOpened({kind:"local"})');
  assert.equal(opened.hasOpenedMachine, true);
  assert.ok(opened.revision > machine.revision);
  const edited = await window.webContents.executeJavaScript('window.elevenex.editMachine({kind:"local"},{name:"My Mac",hue:"rose"})');
  assert.deepEqual(edited.localAppearance, { name: 'My Mac', hue: 'rose' });
  assert.equal(await window.webContents.executeJavaScript('window.elevenex.editMachine({kind:"local"},{name:"bad",hue:"rose",host:"evil"}).then(()=>false,()=>true)'), true);
  const undo = await window.webContents.executeJavaScript(`(async () => {
    const host = await window.elevenex.saveRemoteHost({name:'Saved test machine',host:'unused-test-host',hue:'plum'},null);
    const removed = await window.elevenex.removeMachine(host.id,false);
    const restored = await window.elevenex.undoRemoveMachine(removed.undoToken);
    const again = await window.elevenex.removeMachine(host.id,false);
    await window.elevenex.dismissMachineRemoval(again.undoToken);
    return {id:host.id,removed:removed.state.hosts.length,restored:restored.hosts[0]};
  })()`);
  assert.equal(undo.removed, 0); assert.equal(undo.restored.id, undo.id); assert.equal(undo.restored.hue, 'plum');
  assert.equal(await window.webContents.executeJavaScript('window.elevenex.openMachineWindow({kind:"remote",hostId:"unknown"}).then(()=>false,()=>true)'), true);
  const firstScope = await window.webContents.executeJavaScript('window.elevenex.backendClientState()');
  assert.equal(firstScope.scope.environment.kind, 'local');
  assert.deepEqual(await window.webContents.executeJavaScript(`window.elevenex.backendInfo('${firstScope.scope.id}')`), {
    ok: true, value: { backendSha: revision },
  });
  assert.equal(await window.webContents.executeJavaScript(`window.elevenex.backendInfo('').then(() => false, () => true)`), true);
  await window.webContents.executeJavaScript(`window.smokeClientEvents = [];
    window.smokeStopClient = window.elevenex.onBackendClientChanged(state => window.smokeClientEvents.push(state)); void 0;`);
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
  const restartedScope = await window.webContents.executeJavaScript('window.elevenex.backendClientState()');
  assert.notEqual(restartedScope.scope.id, firstScope.scope.id);
  assert.equal((await window.webContents.executeJavaScript(`window.elevenex.backendInfo('${firstScope.scope.id}')`)).error.code, 'stale-scope');
  const clientEvents = await window.webContents.executeJavaScript('window.smokeClientEvents');
  assert.ok(clientEvents.some(state => state.scope === null));
  assert.equal(clientEvents.at(-1).scope.id, restartedScope.scope.id);
  await window.webContents.executeJavaScript('window.smokeStopClient()');

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
  assert.equal((await second.webContents.executeJavaScript(`window.elevenex.backendInfo('${restartedScope.scope.id}')`)).error.code, 'stale-scope');
  second.destroy();

  await window.loadURL('app://elevenex/smoke/history');
  assert.equal(window.webContents.getURL(), 'app://elevenex/smoke/history');
  assert.equal(await window.webContents.executeJavaScript('typeof window.elevenex.gitStatus'), 'function');
  assert.notEqual((await window.webContents.executeJavaScript('window.elevenex.backendClientState()')).scope.id, restartedScope.scope.id);
  const assets = await window.webContents.executeJavaScript(`(async () => {
    const index = await fetch('/');
    const missing = await fetch('/missing-asset.js');
    return { csp: index.headers.get('Content-Security-Policy'), missing: missing.status };
  })()`);
  assert.ok(assets.csp.includes("script-src 'self'"));
  assert.ok(!assets.csp.includes('unsafe-inline'));
  assert.equal(assets.missing, 404);
  console.log('Electron smoke passed: sandbox, scoped backend HTTP client/lifecycle IPC/events, runtime validation, native theme, multiple windows and app:// history/CSP. Backend runtime is a test fixture.');
  await rm(backendRoot, { recursive: true, force: true });
  clearTimeout(timeout);
  app.quit();
})().catch((error) => {
  console.error(error);
  clearTimeout(timeout);
  app.exit(1);
});
