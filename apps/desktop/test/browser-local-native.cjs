const assert = require('node:assert/strict');
const { BrowserWindow, WebContentsView } = require('electron');
const { createServer } = require('node:http');
const { PassThrough } = require('node:stream');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { WebSocketServer } = require('../../backend/node_modules/ws');
const { browserSocks } = require('@elevenex/browser-network');
const { Wire, SocketChannels } = require('../dist/remote/wire');
const { TaskBrowser } = require('../dist/browser/task');
const { BrowserTaskProfiles } = require('../dist/browser/task-session');
const { BrowserPersistence } = require('../dist/browser/persistence');

// Real Electron pages over the real SOCKS/SSH channel adapters; only the remote
// destination is substituted. No external SSH host or public website is needed.
module.exports = async function localBrowserNative() {
  const root = await mkdtemp(join(tmpdir(), 'elevenex-local-tab-'));
  const routes = [], proxies = [];
  let newTabs = 0;
  const http = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><title>Local over server</title><h1>Local page</h1>');
  });
  const ws = new WebSocketServer({ server: http });
  ws.on('connection', socket => socket.on('message', data => socket.send(data, { binary: false })));
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  const port = http.address().port;
  const toRemote = new PassThrough(), toLocal = new PassThrough();
  const localWire = new Wire(toLocal, toRemote), serverWire = new Wire(toRemote, toLocal);
  const localChannels = new SocketChannels(localWire), serverChannels = new SocketChannels(serverWire);
  serverWire.on('message', frame => {
    if (frame.type === 'browser-open') {
      routes.push([frame.host, frame.port]);
      serverChannels.acceptBrowser(frame.id, frame.host, frame.port, async () => ({ host: '127.0.0.1', port }));
    } else if (frame.type === 'open') {
      routes.push(['task-localhost', frame.port]); serverChannels.accept(frame.id, port, '');
    }
  });
  const window = new BrowserWindow({ show: false });
  const profiles = new BrowserTaskProfiles(), persistence = new BrowserPersistence(root);
  const client = { state: () => ({ scope: { id: 'scope' } }), execute: () => { throw new Error('Local pages must never call the agent mailbox'); } };
  const task = new TaskBrowser('scope', 1, window, client, {}, persistence, 'local-native-' + Date.now(), profiles, true, () => {}, () => true, () => {}, () => {}, 11111, 'embedded', {
    newTab: () => { newTabs++; },
    serverProxy: async authorize => {
      const proxy = await browserSocks(async (host, port) => { authorize(host, port); return { host, port }; },
        (socket, target, opened) => target.host === 'localhost' ? localChannels.open(socket, target.port, opened) : localChannels.openBrowser(socket, target.host, target.port, opened));
      proxies.push(proxy); return proxy;
    },
  });
  let view;
  try {
    let state = await task.command({ kind: 'open', url: `http://remote-only.invalid:${port}/` });
    const tab = state.tabs[0];
    assert.equal(tab.execution, 'local'); assert.equal(tab.routing, 'server'); assert.equal(tab.agentAccess, 'unavailable');
    assert.equal(state.agentCode, undefined);
    const surface = task.surfaces()[0];
    view = new WebContentsView({ webPreferences: { partition: surface.partition, sandbox: true, contextIsolation: true, nodeIntegration: false } });
    await view.webContents.loadURL(surface.bootstrap);
    assert.equal(task.attach(view.webContents, tab.id), true);
    const deadline = Date.now() + 10000;
    while (task.snapshot().tabs[0].loading || view.webContents.getTitle() !== 'Local over server') {
      assert.ok(Date.now() < deadline, 'Local page did not load over SSH'); await delay(25);
    }
    assert.ok(routes.some(([host]) => host === 'remote-only.invalid'), 'The server receives the hostname without local DNS');
    assert.equal(await view.webContents.executeJavaScript(`new Promise((resolve, reject) => { const socket = new WebSocket('ws://remote-only.invalid:${port}/socket'); socket.onopen = () => socket.send('proxied websocket'); socket.onmessage = event => { socket.close(); resolve(event.data); }; socket.onerror = reject; })`), 'proxied websocket');
    await assert.rejects(task.agent({ kind: 'list' }, 2), /unavailable to agents/);
    assert.throws(() => task.code(2, { kind: 'code', code: 'return await browser.pages()', timeoutMs: 1000 }, new AbortController().signal), /unavailable to agents/);
    await assert.rejects(task.command({ kind: 'handoff', tabId: tab.id, sessionId: 2 }), /unavailable to agents/);
    await assert.rejects(task.command({ kind: 'pick', enabled: true }), /unavailable to agents/);
    await task.command({ kind: 'navigate', tabId: tab.id, url: `http://localhost:${port}/task` });
    while (task.snapshot().tabs[0].loading) { assert.ok(Date.now() < deadline); await delay(25); }
    assert.ok(routes.some(([host]) => host === 'task-localhost'), 'Explicit localhost routes to the server');
    assert.equal(view.webContents.getWebRTCIPHandlingPolicy(), 'disable_non_proxied_udp');
    // Electron accepts native keyboard input only in a focused window/view.
    window.contentView.addChildView(view); view.setBounds({ x: 0, y: 0, width: 800, height: 600 });
    window.show(); window.focus(); view.webContents.focus();
    state = task.snapshot();
    task.position({ sequence: 1, surfaceEpoch: state.surfaceEpoch, ownerGeneration: state.tabs[0].generation, visible: true, inputReady: true, reducedMotion: true, bounds: { x: 0, y: 0, width: 800, height: 600 } });
    assert.equal(task.snapshot().tabs[0].ready, true, 'Native input requires a fresh interactive layout');
    view.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'T', modifiers: ['control'] });
    view.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'T', modifiers: ['control'] });
    const shortcutDeadline = Date.now() + 2000;
    while (!newTabs && Date.now() < shortcutDeadline) await delay(10);
    assert.equal(newTabs, 1, 'Native new-tab shortcuts must go through the mixed task owner');
    assert.equal(task.snapshot().tabs.length, 1, 'The local child must not bypass the shared tab limit');
    localWire.close();
    const offline = await view.webContents.executeJavaScript(`fetch('http://unresolvable-after-disconnect.invalid:${port}/').then(() => 'leaked', () => 'blocked')`);
    assert.equal(offline, 'blocked', 'A lost SSH channel must not fall back to direct traffic');
    state = task.snapshot(); assert.equal(state.tabs[0].driver, 'you'); assert.equal(state.tabs[0].waiting, false);
    console.log('Local remote-task browser: native page, server DNS/HTTP/WebSocket, localhost grants, agent exclusion and fail-closed disconnect passed.');
  } finally {
    task.destroy(); if (view && !view.webContents.isDestroyed()) view.webContents.close(); window.destroy();
    await Promise.all(proxies.map(proxy => proxy.close()));
    localChannels.dispose(); serverChannels.dispose(); localWire.close(); serverWire.close();
    await profiles.flush(); await persistence.flush();
    for (const socket of ws.clients) socket.terminate(); ws.close();
    http.closeAllConnections(); await new Promise(resolve => http.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
};
