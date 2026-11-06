const { test } = require('node:test');
const assert = require('node:assert/strict');
const { RemoteBrowserPresentation } = require('../dist/browser/remote-presentation');

function fixture(tabId, loading = false, displayEpoch) {
  const frames = [], layouts = [], cancelled = [], failures = [];
  let resolveFrame, reads = 0, changes = 0;
  const state = { active: 'panel-tab', tabs: [{ id: 'panel-tab', url: 'https://example.com', generation: 1, driver: 'you', loading, displayEpoch }, { id: 'companion-tab', url: 'https://example.com', generation: 1, driver: 'you', loading, displayEpoch }] };
  const host = {
    scopeId: 'scope', taskId: 1,
    state: () => state,
    ready: () => true, changed: () => changes++,
    layout: async (tabId, value) => { layouts.push({ tabId, ...value }); },
    frame: () => { reads++; return new Promise(resolve => { resolveFrame = resolve; }); },
    cancel: id => cancelled.push(id), deliver: frame => frames.push(frame), failed: error => failures.push(error),
  };
  const view = new RemoteBrowserPresentation(host, { visible: () => true, zoom: () => 1, pixelRatio: () => 1, colorScheme: () => 'light' }, tabId);
  const position = (sequence = 1) => view.position({ surfaceEpoch: view.epoch, sequence, visible: true, inputReady: true, bounds: { x: 0, y: 0, width: 800, height: 600 } });
  return { view, position, state, host, frames, layouts, cancelled, failures, changes: () => changes, reads: () => reads, resolve: (n, displayEpoch) => resolveFrame({ sequence: n, width: 800, height: 600, jpeg: new Uint8Array([1]), ...(displayEpoch === undefined ? {} : { displayEpoch }) }) };
}
const settle = async () => { for (let n = 0; n < 8; n++) await Promise.resolve(); };

test('loading pages stay visible and continue receiving streamed frames', async () => {
  const f = fixture(undefined, true);
  f.position(); await settle();
  assert.equal(f.view.surfaces()[0].visible, true);
  assert.equal(f.reads(), 1);
  f.resolve(1); await settle();
  assert.equal(f.frames.length, 1);
  f.view.destroy();
});

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

test('retires queued old-document frames without displaying them or losing the next frame credit', async () => {
  const f = fixture(undefined, false, 2);
  try {
    f.position(); await settle();
    f.resolve(1, 1); await settle();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(f.frames.length, 0);
    assert.equal(f.reads(), 2);
    f.resolve(2, 2); await settle();
    assert.equal(f.frames.length, 1);
    assert.equal(f.frames[0].displayEpoch, 2);
  } finally { f.view.destroy(); }
});

test('reconciles a future document frame and keeps identical layout heartbeats quiet', async () => {
  const f = fixture(undefined, false, 2);
  f.host.synchronize = async () => { f.state.tabs[0].displayEpoch = 3; };
  try {
    f.position(); await settle();
    const changes = f.changes();
    f.position(2); await settle();
    assert.equal(f.changes(), changes);
    f.resolve(1, 3); await settle();
    assert.equal(f.frames[0].displayEpoch, 3);
    assert.equal(f.failures.length, 0);
  } finally { f.view.destroy(); }
});

test('a lost display receipt recovers only its presentation and ignores the retired receipt', async context => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const f = fixture();
  try {
    f.position(); await settle(); f.resolve(1); await settle();
    const old = f.frames[0];
    // Keep layout authority alive while simulating a renderer dropping one ack.
    context.mock.timers.tick(5001);
    f.position(2); await settle();
    assert.equal(f.reads(), 1);
    f.view.maintain(); await settle();
    assert.equal(f.reads(), 2);
    f.resolve(1); await settle();
    assert.notEqual(f.frames[1].streamId, old.streamId);
    f.view.acknowledge('panel-tab', old.streamId, old.sequence);
    assert.equal(f.reads(), 2);
    f.view.acknowledge('panel-tab', f.frames[1].streamId, 1);
    assert.equal(f.reads(), 3);
    assert.equal(f.failures.length, 0);
  } finally { f.view.destroy(); }
});
