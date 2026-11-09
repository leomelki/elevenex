const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { setTimeout: delay } = require('node:timers/promises');
const { setInterval, clearInterval } = require('node:timers');
const { randomUUID } = require('node:crypto');
const { app, BrowserWindow, session } = require('electron');
const { BrowserPage } = require('../dist/browser/surface');

async function until(check, message) {
  for (let i = 0; i < 200; i++) { const value = await check(); if (value) return value; await delay(25); }
  throw new Error(message);
}
module.exports = async function pickerSmoke() {
  const server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end(`<!doctype html><style>body{margin:0;height:2000px}button{position:fixed;left:200px;top:50px;width:120px;height:40px}#nested{position:absolute;left:20px;top:100px;height:100px;width:120px;overflow:auto}</style><button onclick="window.clicks++">Pick me</button><div id="nested"><div style="height:1000px">Scroll here</div></div><script>window.clicks=0</script>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const window = new BrowserWindow({ show: false });
  const partition = 'picker-' + randomUUID();
  let picked;
  const page = new BrowserPage({ window, scopeId: 'picker', taskId: 1, session: session.fromPartition(partition), partition,
    resourceUrl: value => value, logicalUrl: value => value, configure: async () => undefined,
    changed: () => undefined, frame: () => undefined, authorized: () => true,
    pick: element => { picked = element; page.picking = false; }, attention: () => undefined,
    shortcut: kind => { if (kind === 'pick') page.picking = !page.picking; },
  }, 'you');
  try {
    page.ensureAgentView(); page.load(url, url);
    await until(() => !page.loading, 'Picker fixture did not load');
    const show = zoom => page.show({ x: 0, y: 0, width: 800, height: 600 }, zoom, page.lease.generation, true, { width: 800 / zoom, height: 600 / zoom });
    show(1); await until(() => page.ready, 'Picker fixture not ready');
    page.picking = true;
    page.contents.sendInputEvent({ type: 'mouseMove', x: 250, y: 70 });
    await until(() => page.snapshot().hovered?.tag === 'button', 'Native point hover missing');
    assert.deepEqual(page.snapshot().hovered, { tag: 'button', x: 200, y: 50, width: 120, height: 40 });
    await page.contents.executeJavaScript(`document.querySelector('button').insertAdjacentHTML('afterend', '<button style="left:400px">Another target</button>')`);
    const samples = new Set();
    let move = 0;
    const moving = setInterval(() => {
      page.contents.sendInputEvent({ type: 'mouseMove', x: ++move % 2 ? 250 : 450, y: 70 });
      const hover = page.snapshot().hovered; if (hover?.tag === 'button') samples.add(hover.x);
    }, 8);
    try { await until(() => samples.has(200) && samples.has(400), 'Continuous motion starved picker feedback'); }
    finally { clearInterval(moving); }
    page.contents.sendInputEvent({ type: 'mouseMove', x: 50, y: 130 });
    page.contents.sendInputEvent({ type: 'mouseWheel', x: 50, y: 130, deltaY: -60, deltaX: 0, canScroll: true });
    await until(() => page.contents.executeJavaScript('document.querySelector("#nested").scrollTop > 0'), 'Native picker blocked nested scroll');
    assert.equal(page.picking, true);
    page.contents.sendInputEvent({ type: 'mouseLeave', x: -1, y: -1 });
    await until(() => !page.snapshot().hovered, 'Native hover survived pointer exit');
    page.contents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    page.contents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await until(() => !page.picking, 'Native Escape did not cancel picking');
    page.load(url + '?stream', url + '?stream');
    await until(() => !page.loading, 'Stream fixture did not load');
    show(1);
    page.picking = true;
    await page.userInput(page.lease.generation, { kind: 'pointer', type: 'move', x: 250, y: 70, button: 'none', buttons: 0, clicks: 0, modifiers: 0 });
    await until(() => page.snapshot().hovered?.tag === 'button', 'Local stream point hover missing');
    await page.userInput(page.lease.generation, { kind: 'wheel', x: 50, y: 130, deltaX: 0, deltaY: 80, modifiers: 0 });
    await until(() => page.contents.executeJavaScript('document.querySelector("#nested").scrollTop > 0'), 'Local stream picker blocked scrolling');
    page.picking = false; await page.contents.executeJavaScript('scrollTo(0,0)');
    show(1.25); page.picking = true;
    page.contents.sendInputEvent({ type: 'mouseMove', x: 313, y: 88 });
    await until(() => page.snapshot().hovered?.tag === 'button', 'Zoomed point hover missing');
    assert.deepEqual(page.snapshot().hovered, { tag: 'button', x: 200, y: 50, width: 120, height: 40 });
    page.contents.sendInputEvent({ type: 'mouseDown', x: 313, y: 88, button: 'left', clickCount: 1 });
    page.contents.sendInputEvent({ type: 'mouseUp', x: 313, y: 88, button: 'left', clickCount: 1 });
    await until(() => picked, 'Native pick did not resolve');
    assert.equal(picked.tag, 'button');
    assert.equal(await page.contents.executeJavaScript('window.clicks'), 0, 'Picking activated the target');
    show(1.25);
    page.picking = true;
    page.contents.sendInputEvent({ type: 'mouseMove', x: 313, y: 88 });
    await until(() => page.snapshot().hovered, 'Second hover missing');
    page.hide(); assert.equal(page.snapshot().hovered, undefined);
    const timings = [];
    for (let i = 0; i < 8; i++) {
      picked = undefined; show(1.25); page.picking = true; page.visualPicking = true;
      const start = performance.now();
      await page.userInput(page.lease.generation, { kind: 'pointer', type: 'down', x: 250, y: 70, button: 'left', buttons: 1, clicks: 1, modifiers: 0 });
      await until(() => picked, 'A first click did not capture the element');
      timings.push(Math.round(performance.now() - start));
      assert.ok(picked.snapshot?.jpeg, 'Each first click returns real pixels');
      assert.equal(picked.snapshot.reference.tag, 'button');
      assert.equal(await page.contents.executeJavaScript('window.clicks'), 0);
    }
    console.log('First-click capture latency (ms):', JSON.stringify(timings));
    console.log('Picker smoke passed: native/stream hover and nested scroll, zoom, Escape, non-activating selection, hide cleanup.');
  } finally {
    page.destroy(); window.destroy(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
};
if (process.argv[1]?.endsWith('browser-picker-native.cjs')) app.whenReady().then(() => module.exports()).then(() => app.quit(), error => { console.error(error); app.exit(1); });
