const { test } = require('node:test');
const assert = require('node:assert/strict');
const { RemoteBrowserPresentation } = require('../dist/browser/remote-presentation');

function fixture(tabId) {
  const frames = [], layouts = [], cancelled = [], failures = [];
  let resolveFrame, reads = 0;
  const host = {
    scopeId: 'scope', taskId: 1,
    state: () => ({ active: 'panel-tab', tabs: [{ id: 'panel-tab', url: 'https://example.com', generation: 1, driver: 'you' }, { id: 'companion-tab', url: 'https://example.com', generation: 1, driver: 'you' }] }),
    ready: () => true, changed: () => undefined,
    layout: async (tabId, value) => { layouts.push({ tabId, ...value }); },
    frame: () => { reads++; return new Promise(resolve => { resolveFrame = resolve; }); },
    cancel: id => cancelled.push(id), deliver: frame => frames.push(frame), failed: error => failures.push(error),
  };
  const view = new RemoteBrowserPresentation(host, { visible: () => true, zoom: () => 1, pixelRatio: () => 1, colorScheme: () => 'light' }, tabId);
  const position = (sequence = 1) => view.position({ surfaceEpoch: view.epoch, sequence, visible: true, inputReady: true, bounds: { x: 0, y: 0, width: 800, height: 600 } });
  return { view, position, frames, layouts, cancelled, failures, reads: () => reads, resolve: n => resolveFrame({ sequence: n, width: 800, height: 600, jpeg: new Uint8Array([1]) }) };
}
const settle = async () => { for (let n = 0; n < 8; n++) await Promise.resolve(); };

test('panel and companion own independent layout, frame receipts, visibility and cleanup', async () => {
  const panel = fixture(), companion = fixture('companion-tab');
  panel.position(); companion.position(); await settle();
  panel.resolve(1); companion.resolve(1); await settle();
  assert.equal(panel.frames.length, 1); assert.equal(companion.frames.length, 1);
  assert.notEqual(panel.frames[0].streamId, companion.frames[0].streamId);
  companion.view.acknowledge('companion-tab', panel.frames[0].streamId, 1);
  assert.equal(companion.reads(), 1, 'another display cannot acknowledge this frame');
  panel.view.hide();
  assert.equal(companion.view.interactive, true);
  companion.view.acknowledge('companion-tab', companion.frames[0].streamId, 1);
  assert.equal(companion.reads(), 2);
  assert.equal(panel.layouts.at(-1).visible, false);
  assert.equal(companion.layouts.at(-1).visible, true);
  panel.view.destroy(); companion.view.destroy();
  assert.equal(panel.failures.length + companion.failures.length, 0);
});

test('late frames and stale layouts cannot revive a hidden or reset display', async () => {
  const f = fixture(); f.position(); await settle();
  f.view.hide(); f.resolve(1); await settle();
  assert.equal(f.frames.length, 0);
  f.view.position({ surfaceEpoch: 0, sequence: 2, visible: true, inputReady: true, bounds: { x: 0, y: 0, width: 800, height: 600 } });
  assert.equal(f.view.visible, false);
  f.position(3); await settle(); f.view.reset(); f.resolve(2); await settle();
  assert.equal(f.frames.length, 0);
  assert.ok(f.cancelled.length > 0);
  f.view.destroy();
});

test('expired presentation heartbeat closes input and stream without destroying another display', async context => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const f = fixture(); f.position(); await settle();
  context.mock.timers.tick(751); f.view.maintain();
  assert.equal(f.view.interactive, false);
  assert.equal(f.layouts.at(-1).visible, false);
  f.view.destroy();
});
