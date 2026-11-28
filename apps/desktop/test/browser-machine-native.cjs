const { WebSocketServer } = require('ws');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { BrowserWindow } = require('electron');
const { BackendClient } = require('../dist/backend-client/client');
const { RemoteTaskBrowser } = require('../dist/browser/remote-task');

/** Real main adapter/HTTP transport with a deterministic machine host. Chromium host has its own integration suite. */
module.exports = async function machineBrowserSmoke() {
  await startupSmoke();
  for (const { layoutLanes, streaming } of [{ layoutLanes: true, streaming: true }, { layoutLanes: true, streaming: false }, { layoutLanes: false, streaming: false }]) {
    const token = randomUUID(), first = randomUUID(), second = randomUUID(), frames = [], layouts = [];
    let connects = 0, disconnects = 0, revision = 1, upgrades = 0, httpFrames = 0;
    const tab = id => ({ id, title: 'Page', url: 'https://example.com/', by: 'you', driver: 'you', agentSessionId: null, generation: 1, loading: false, ready: true, canGoBack: false, error: null, errors: 0, width: 'full', theme: 'system', slowNetwork: false, waiting: false });
    const state = () => ({ taskId: 1, revision: revision++, surfaceEpoch: 0, controlsFocus: 0, active: first, tabs: [tab(first), tab(second)], canDetach: true, ...(streaming ? { streamVersion: 1 } : {}), ...(layoutLanes ? { layoutLanes: true } : {}), picked: null, picking: false, pickerMessage: null, feedback: false, ports: [], privacy: 'content-withheld' });
    const server = createServer(async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1'), path = url.pathname.split('/').at(-1);
      let body = ''; for await (const chunk of req) body += chunk;
      if (path !== 'initial' && path !== 'connect') assert.equal(req.headers['x-elevenex-browser-view'], token);
      res.setHeader('content-type', 'application/json');
      if (path === 'initial') res.end(JSON.stringify(state()));
      else if (path === 'connect') { connects++; res.end(JSON.stringify({ token, state: state() })); }
      else if (path === 'state') res.end(JSON.stringify(state()));
      else if (path === 'layout') { layouts.push(JSON.parse(body)); res.end(JSON.stringify(state())); }
      else if (path === 'disconnect') { disconnects++; res.end('{}'); }
      else if (path === 'frame') {
        httpFrames++;
        const metadata = Buffer.from(JSON.stringify({ sequence: Number(url.searchParams.get('after')) + 1, width: 800, height: 600 })), size = Buffer.alloc(4);
        size.writeUInt32BE(metadata.length); res.end(Buffer.concat([size, metadata, Buffer.from([255, 216, 255, 217])]));
      } else { res.statusCode = 404; res.end('{}'); }
    });
    const sockets = new WebSocketServer({ noServer: true, perMessageDeflate: false });
    server.on('upgrade', (request, socket, head) => {
      assert.equal(request.headers['x-elevenex-browser-view'], token);
      sockets.handleUpgrade(request, socket, head, ws => {
        upgrades++;
        ws.on('message', data => {
          const { id, method, body } = JSON.parse(data.toString());
          if (method === 'cancel') return;
          if (method === 'frame') {
            const metadata = Buffer.from(JSON.stringify({ id, sequence: body.after + 1, width: 800, height: 600 })), size = Buffer.alloc(4);
            size.writeUInt32BE(metadata.length);
            ws.send(Buffer.concat([size, metadata, Buffer.from([255, 216, 255, 217])]));
          } else {
            if (method === 'layout') layouts.push(body);
            ws.send(JSON.stringify({ id, result: method === 'ping' ? null : state() }));
          }
        });
        ws.send(JSON.stringify({ event: 'state', state: state() }));
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const window = new BrowserWindow({ show: false }), companion = new BrowserWindow({ show: false });
    const client = new BackendClient(() => ({ identity: 'machine-test', url: 'http://127.0.0.1:' + server.address().port, version: 'a'.repeat(40), headers: {}, environment: { kind: 'local' } }), () => undefined);
    client.attach(window.webContents.id);
    const scope = client.state(window.webContents.id).scope.id;
    const browser = new RemoteTaskBrowser(scope, 1, window, client, () => undefined, () => true, () => undefined, frame => frames.push(frame), {}, false);
    const layout = (epoch, sequence) => ({ surfaceEpoch: epoch, sequence, visible: true, inputReady: true, reducedMotion: false, ownerGeneration: 1, bounds: { x: 0, y: 0, width: 800, height: 600 } });
    const until = async predicate => { const end = Date.now() + 5000; while (!predicate()) { assert.ok(Date.now() < end, 'Machine browser condition timed out'); await delay(10); } };
    try {
      await browser.restore(); browser.position(layout(browser.snapshot().surfaceEpoch, 1));
      await until(() => frames.some(frame => frame.tabId === first));
      browser.detachTab(second, companion);
      browser.positionDetached(second, layout(browser.detachedSnapshot(second).surfaceEpoch, 1));
      await until(() => frames.some(frame => frame.tabId === second));
      assert.equal(connects, 1, 'Companions must share the task viewer connection');
      assert.equal(upgrades, streaming ? 1 : 0);
      if (streaming) assert.equal(httpFrames, 0, 'Upgraded hosts never poll frames over HTTP');
      browser.suspend(); await until(() => layouts.some(item => item.visible === false && !item.tabId));
      assert.equal(disconnects, 0, 'A visible companion keeps the viewer alive');
      assert.equal(browser.detachedSurfaces(second)[0].visible, true);
      browser.returnTab(second); browser.maintain(); await until(() => disconnects === 1);
      const sequences = layouts.map(item => item.sequence);
      if (!layoutLanes) assert.equal(new Set(sequences).size, sequences.length, 'Older hosts retain shared monotonic ordering');
      else assert.equal(layouts.find(item => item.tabId === second).sequence, 1, 'New hosts use an independent tab lane');
    } finally {
      browser.destroy(); client.dispose(); window.destroy(); companion.destroy();
      for (const socket of sockets.clients) socket.terminate();
      sockets.close();
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    }
  }
  console.log('Machine browser smoke passed: one task lease, independent presentations, legacy layout fallback and last-display cleanup.');
};

async function startupSmoke() {
  const token = randomUUID(), tabId = randomUUID();
  let tabs = [], revision = 0, connects = 0, commands = 0, frames = 0, upgrade;
  const state = () => ({ taskId: 1, revision: ++revision, surfaceEpoch: 0, controlsFocus: 0,
    active: tabs[0]?.id ?? null, tabs, streamVersion: 1, picked: null, picking: false,
    pickerMessage: null, feedback: false, ports: [], privacy: 'content-withheld' });
  const server = createServer(async (request, response) => {
    const path = request.url.split('/').at(-1);
    for await (const chunk of request) { void chunk; }
    response.setHeader('content-type', 'application/json');
    if (path === 'initial') response.end(JSON.stringify(state()));
    else if (path === 'connect') { connects++; response.end(JSON.stringify({ token, state: state() })); }
    else if (path === 'state') response.end(JSON.stringify(state()));
    else if (path === 'disconnect') response.end('{}');
    else { response.statusCode = 400; response.end('{}'); }
  });
  const sockets = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    upgrade = () => sockets.handleUpgrade(request, socket, head, ws => {
      ws.on('message', data => {
        const { id, method, body } = JSON.parse(data);
        if (method === 'command') {
          commands++;
          assert.equal(body.kind, 'new-tab');
          tabs = [{ id: tabId, title: 'New tab', url: '', by: 'you', driver: 'you', agentSessionId: null,
            generation: 1, loading: false, ready: false, canGoBack: false, error: null, errors: 0,
            width: 'full', theme: 'system', slowNetwork: false, waiting: false }];
        } else if (method === 'frame') frames++;
        ws.send(JSON.stringify({ id, result: method === 'ping' ? null : state() }));
      });
      ws.send(JSON.stringify({ event: 'state', state: state() }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const window = new BrowserWindow({ show: false });
  const client = new BackendClient(() => ({ identity: 'startup-test', url: 'http://127.0.0.1:' + server.address().port,
    version: 'a'.repeat(40), headers: {}, environment: { kind: 'local' } }), () => undefined);
  client.attach(window.webContents.id);
  const scope = client.state(window.webContents.id).scope.id;
  const browser = new RemoteTaskBrowser(scope, 1, window, client, () => undefined, () => true, () => undefined, () => undefined, {}, false);
  let command, refresh;
  try {
    await browser.restore();
    // The renderer automatically creates its first blank tab before geometry
    // and the private socket are necessarily ready. Hold the actual upgrade.
    command = browser.command({ kind: 'new-tab' });
    const deadline = Date.now() + 5000;
    while (!upgrade) { assert.ok(Date.now() < deadline); await delay(10); }
    refresh = browser.refresh();
    assert.equal(commands, 0, 'No command is dispatched before the channel is ready');
    upgrade();
    const opened = await command;
    await refresh;
    assert.equal(opened.active, tabId);
    assert.equal(browser.snapshot().connection.phase, 'ready');
    assert.equal(connects, 1, 'Concurrent metadata refresh does not rotate the opening viewer');
    assert.equal(commands, 1, 'Startup sends the command exactly once');
    browser.position({ surfaceEpoch: browser.snapshot().surfaceEpoch, sequence: 1, visible: true, inputReady: true,
      reducedMotion: false, ownerGeneration: 1, bounds: { x: 0, y: 0, width: 800, height: 600 } });
    await delay(50);
    assert.equal(frames, 0, 'Blank tabs never hold a pixel request or its deadline');
  } finally {
    browser.destroy(); client.dispose(); window.destroy();
    for (const socket of sockets.clients) socket.terminate();
    await Promise.allSettled([command, refresh]);
    sockets.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
}
