// Run with Electron after building. This exercises the real sandboxed preload
// and app:// handler, rather than Node mocks. Not part of the headless unit suite.
const { app, BrowserWindow, Menu, nativeTheme } = require('electron');
const assert = require('node:assert/strict');
const { mkdtempSync } = require('node:fs');
const { rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createServer } = require('node:http');
const { URL } = require('node:url');
const { BackendManager } = require('../dist/backend/manager');
const { backendRelease } = require('../dist/backend/release');
const remoteContract = require('./remote-contract.cjs');
const machineContract = require('./machine-contract.cjs');
const workspaceContract = require('./workspace-contract.cjs');

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
      const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
      const responses = {
        '/api/info': { backendSha: revision },
        '/api/desktop-workspace/revision': { revision: 0, version: 1 },
        '/api/desktop-workspace/projects': { items: [], nextCursor: null },
        '/api/desktop-workspace/tasks': { items: [], nextCursor: null },
        '/api/desktop-workspace/folders': [],
      };
      assert.equal(request.method, 'GET');
      assert.ok(Object.hasOwn(responses, pathname), `Unexpected smoke endpoint: ${pathname}`);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(responses[pathname]));
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
  assert.deepEqual(bridge.keys, ['appVersion', 'backendStatus', 'gitStatus', 'onBackendChanged', 'onThemeChanged', 'platform', 'restartBackend', 'retryBackend', 'backendClientState', 'backendInfo', 'onBackendClientChanged', ...remoteContract.methods, ...machineContract.methods, ...workspaceContract.methods].sort());
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
  // Exercise the production deferred workspace through app://, real IPC and HTTP.
  // This also catches missing style nonces when its lazy components are mounted.
  await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const until = Date.now() + 10000;
    const open = () => {
      const card = document.querySelector('[data-machine="local"]');
      if (card && !card.disabled) { card.click(); resolve(); }
      else if (Date.now() > until) reject(new Error('Machine Home did not render'));
      else setTimeout(open, 25);
    };
    open();
  })`);
  const workspace = await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const until = Date.now() + 10000;
    const inspect = () => {
      const project = document.querySelector('ex-workspace-onboarding ex-new-project');
      const shell = document.querySelector('ex-machine-workspace ex-app-shell');
      const opened = document.querySelector('ex-machine-launch .launch.open ex-machine-workspace:not([inert])');
      if (project && shell && opened) resolve({ titles: document.querySelectorAll('ex-title-bar').length,
        display: getComputedStyle(shell).display, cardDisplay: getComputedStyle(project).display,
        inert: document.querySelector('.workspace-frame').hasAttribute('inert') });
      else if (Date.now() > until) reject(new Error('Connected workspace did not render'));
      else setTimeout(inspect, 25);
    };
    inspect();
  })`);
  assert.deepEqual(workspace, { titles: 1, display: 'flex', cardDisplay: 'block', inert: true });
  await window.webContents.executeJavaScript(`window.smokeClientEvents = [];
    window.smokeStopClient = window.elevenex.onBackendClientChanged(state => window.smokeClientEvents.push(state)); void 0;`);
  const remote = await window.webContents.executeJavaScript(`(async () => {
    const hosts = await window.elevenex.remoteHosts();
    const state = await window.elevenex.environmentStatus();
    const invalid = await window.elevenex.saveRemoteHost({name:'bad',host:'-oProxyCommand=evil'},null).then(()=>false,()=>true);
    const workspace = {panel:'browser',panelOpen:true,wideReview:false,closed:false,focused:false,filter:null,projectCursor:null,taskCursor:null};
    await window.elevenex.saveEnvironmentContext({projectId:null,taskId:null,sessionId:null,draft:'unsent',cursor:'cursor',workspace}, {kind:'local'});
    const saved = await window.elevenex.environmentStatus();
    const invalidLayout = await window.elevenex.saveEnvironmentContext({...saved.context,workspace:{...workspace,panel:'invalid'}}, {kind:'local'}).then(()=>false,()=>true);
    return {hosts,state,invalid,saved,invalidLayout};
  })()`);
  assert.deepEqual(remote.hosts, []); assert.equal(remote.state.selection.kind, 'local'); assert.equal(remote.invalid, true);
  assert.equal(remote.saved.context.workspace.panel, 'browser'); assert.equal(remote.saved.context.workspace.panelOpen, true);
  assert.equal(remote.invalidLayout, true);
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
  console.log('Electron smoke passed: sandbox, connected deferred workspace, scoped backend HTTP client/lifecycle IPC/events, runtime validation, native theme, multiple windows and app:// history/CSP. Backend runtime is a test fixture.');
  await rm(backendRoot, { recursive: true, force: true });
  clearTimeout(timeout);
  app.quit();
})().catch((error) => {
  console.error(error);
  clearTimeout(timeout);
  app.exit(1);
});
