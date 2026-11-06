// Run with Electron after building. Real app browser registration and sandboxed
// preload, with an isolated HTTP host; the Chromium host has integration tests.
const { app, BrowserWindow, Menu } = require('electron');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { mkdtempSync } = require('node:fs');
const { rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { BackendClient } = require('../dist/backend-client/client');
const { registerTaskBrowser } = require('../dist/browser/application');

const root = mkdtempSync(join(tmpdir(), 'elevenex-remote-input-'));
app.setPath('userData', root);
async function run() {
  Menu.setApplicationMenu(null);
  const tabId = randomUUID(), token = randomUUID(), inputs = [];
  let sequence = 0, generation = 1, holdReceipt = false, receivedHeld, releaseHeld;
  const heldReceived = new Promise(resolve => { receivedHeld = resolve; });
  const heldRelease = new Promise(resolve => { releaseHeld = resolve; });
  const state = () => ({ taskId: 1, revision: generation, surfaceEpoch: 0, controlsFocus: 0,
    keyText: true, inputWindow: 4, active: tabId, picked: null, picking: false, pickerMessage: null,
    feedback: false, ports: [], privacy: 'content-withheld', tabs: [{ id: tabId, title: 'Fixture',
      url: 'https://example.com', by: 'you', driver: 'you', agentSessionId: null, generation,
      displayEpoch: 1, loading: false, ready: true, canGoBack: false, error: null, errors: 0,
      width: 'full', theme: 'system', slowNetwork: false, waiting: false }] });
  const server = createServer(async (request, response) => {
    let bytes = ''; for await (const chunk of request) bytes += chunk;
    const path = new URL(request.url, 'http://127.0.0.1').pathname;
    response.setHeader('content-type', 'application/json');
    if (path === '/api/desktop-browser/tasks/1') response.end(JSON.stringify({ id: 1, repoId: 1, state: 'ready', identity: 'a'.repeat(64) }));
    else if (path.endsWith('/connect')) response.end(JSON.stringify({ token, state: state() }));
    else if (path.endsWith('/input')) {
      inputs.push(JSON.parse(bytes).input);
      if (holdReceipt) { receivedHeld(); await heldRelease; }
      else await delay(inputs.length % 2 ? 180 : 30);
      response.end(JSON.stringify({ generation: 1, revision: 1 }));
    } else if (path.endsWith('/command')) {
      generation++;
      response.end(JSON.stringify(state()));
    } else if (path.endsWith('/frame')) {
      const metadata = Buffer.from(JSON.stringify({ sequence: ++sequence, displayEpoch: 1, width: 800, height: 600 }));
      const length = Buffer.alloc(4); length.writeUInt32BE(metadata.length);
      response.end(Buffer.concat([length, metadata, Buffer.from([255, 216, 255])]));
    } else response.end(JSON.stringify(state()));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const window = new BrowserWindow({ show: true, width: 800, height: 600,
    webPreferences: { preload: require.resolve('../dist/preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const client = new BackendClient(() => ({ identity: 'remote-input-fixture', url: `http://127.0.0.1:${server.address().port}`,
    headers: {}, environment: { kind: 'remote', hostId: 'fixture' } }), () => undefined);
  client.attach(window.webContents.id);
  // Trust only this fixture's main frame; no production origin policy is changed.
  const browsers = registerTaskBrowser(client, { configurationIdentity: () => 'fixture' }, root,
    (frame, contents) => contents === window.webContents && frame === contents.mainFrame);
  const until = async predicate => {
    const deadline = Date.now() + 10000;
    while (!await predicate()) { assert.ok(Date.now() < deadline, 'Remote input condition timed out'); await delay(10); }
  };
  try {
    await window.loadURL('data:text/html,<textarea aria-label="Remote page input"></textarea>');
    const scope = client.state(window.webContents.id).scope.id;
    await window.webContents.executeJavaScript(`(async () => {
      const scope = ${JSON.stringify(scope)}, tab = ${JSON.stringify(tabId)};
      const read = await window.elevenex.taskBrowserRead(scope, 1);
      if (!read.ok) throw Error('Fixture browser unavailable');
      let epoch = read.value.surfaceEpoch, sequence = 0;
      window.elevenex.onTaskBrowserChanged(state => epoch = state.surfaceEpoch);
      const layout = () => window.elevenex.taskBrowserLayout(scope, 1, { sequence: ++sequence, surfaceEpoch: epoch,
        ownerGeneration: 1, visible: true, inputReady: true, reducedMotion: true,
        bounds: { x: 0, y: 0, width: 800, height: 600 }, viewport: { width: 800, height: 600 } });
      await layout(); window.fixtureHeartbeat = setInterval(() => layout().catch(() => {}), 100);
      window.fixtureResults = [];
      document.querySelector('textarea').addEventListener('keydown', event => {
        event.preventDefault();
        const input = event.key === 'z' ? { kind: 'edit', operation: 'undo' }
          : { kind: 'key', type: 'down', key: event.key, code: event.code, keyCode: event.keyCode,
            modifiers: Number(event.altKey) | Number(event.ctrlKey) << 1 | Number(event.metaKey) << 2 };
        window.elevenex.taskBrowserInput(scope, 1, tab, 1, input).then(() => window.fixtureResults.push(true), () => window.fixtureResults.push(false));
      });
      document.querySelector('textarea').focus();
    })()`);
    await until(async () => (await window.webContents.executeJavaScript('window.elevenex.taskBrowserSurfaces()')).some(surface => surface.interactive));
    window.focus(); window.webContents.focus();
    for (const modifiers of [['meta'], ['control'], ['alt'], ['control', 'alt']]) {
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Z', modifiers });
      window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Z', modifiers });
    }
    await until(async () => (await window.webContents.executeJavaScript('window.fixtureResults.length')) === 4);
    assert.equal(inputs.length, 4, 'Every modified page key reached the remote input lane');
    assert.deepEqual(await window.webContents.executeJavaScript('window.fixtureResults'), [true, true, true, true]);
    holdReceipt = true;
    await window.webContents.executeJavaScript(`void (window.fixtureLateInput = window.elevenex.taskBrowserInput(${JSON.stringify(scope)}, 1, ${JSON.stringify(tabId)}, 1, { kind: 'text', text: 'before-control-change' }))`);
    await heldReceived;
    const command = await window.webContents.executeJavaScript(`window.elevenex.taskBrowserCommand(${JSON.stringify(scope)}, 1, { kind: 'takeover', tabId: ${JSON.stringify(tabId)} })`);
    assert.equal(command.ok, true);
    assert.equal(command.value.tabs[0].generation, 2);
    releaseHeld();
    await window.webContents.executeJavaScript('window.fixtureLateInput');
    const surfaces = await window.webContents.executeJavaScript('window.elevenex.taskBrowserSurfaces()');
    assert.equal(surfaces[0].generation, 2, 'A late input receipt cannot roll back newer authoritative state');
    console.log('Remote input native smoke passed: real registration/preload, modifier keys, jittered receipts and control-generation races.');
  } finally {
    releaseHeld();
    if (!window.isDestroyed()) await window.webContents.executeJavaScript('clearInterval(window.fixtureHeartbeat)').catch(() => undefined);
    browsers.dispose(); await browsers.flush(); client.dispose(); window.destroy();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
}
app.whenReady().then(run).then(async () => { await rm(root, { recursive: true, force: true }); app.exit(0); }, async error => {
  console.error(error); await rm(root, { recursive: true, force: true }); app.exit(1);
});
