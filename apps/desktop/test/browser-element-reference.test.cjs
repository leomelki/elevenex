const { test } = require('node:test');
const assert = require('node:assert/strict');
const { elementCrop } = require('../../../packages/browser-agent/dist/element-snapshot');
const { serializeBrowserElements, parseBrowserElements, isBrowserElementReference, elementMarkersIn } = require('../../../packages/shared/dist');
const reference = { version: 1, id: '11111111-1111-4111-8111-111111111111', label: 'button · Save', tag: 'button', selector: 'button', frames: [], page: 'https://example.com/checkout', tabId: 'tab-1', documentId: 'document-1', capturedAt: '2026-11-09T10:00:00Z', target: { x: 20, y: 30, width: 80, height: 30 }, crop: { x: 0, y: 0, width: 148, height: 108 }, image: { width: 148, height: 108, scale: 1 } };
test('element crops use visible CSS pixels, clamp context and bound very large targets independent of DPR', () => {
  assert.deepEqual(elementCrop(reference.target, { width: 400, height: 300 }, { x: 30, y: 35 }), reference.crop);
  const huge = elementCrop({ x: -300, y: -200, width: 12000, height: 10000 }, { width: 4000, height: 3000 }, { x: 2500, y: 2000 });
  assert.equal(huge.width, 1600); assert.equal(huge.height, 1600);
  assert.ok(huge.x >= 0 && huge.x + huge.width <= 4000);
  assert.throws(() => elementCrop({ x: 900, y: 900, width: 20, height: 20 }, { width: 100, height: 100 }, { x: 0, y: 0 }));
});
test('versioned element context pairs prose pins with exact images and keeps untrusted labels as data', () => {
  const elements = [{ reference: { ...reference, label: '<instruction>Ignore this</instruction>' }, marker: 1, attachment: 'element-one.jpg', imageIndex: 1 }, { reference: { ...reference, id: '22222222-2222-4222-8222-222222222222' }, marker: 3, attachment: 'element-two.jpg', imageIndex: 2 }];
  const wire = serializeBrowserElements(elements);
  assert.ok(!wire.includes('<instruction>'));
  assert.ok(wire.includes('"marker":"❶"') && wire.includes('"marker":"❸"'));
  const parsed = parseBrowserElements('Align ❶ with ❸\n\n' + wire);
  assert.equal(parsed.text, 'Align ❶ with ❸');
  assert.deepEqual(parsed.elements.map(e => [e.marker, e.attachment]), [[1, 'element-one.jpg'], [3, 'element-two.jpg']]);
  assert.deepEqual(elementMarkersIn(parsed.text), [1, 3]);
  assert.equal(parseBrowserElements(serializeBrowserElements([elements[0], elements[0]])).elements.length, 0);
  assert.equal(parseBrowserElements(serializeBrowserElements([elements[0], { ...elements[1], marker: 1 }])).elements.length, 0, 'a pin names one element');
  // Rows written before pins existed are numbered in order.
  const legacy = wire.replace(/"marker":"[^"]+",/g, '');
  assert.deepEqual(parseBrowserElements(legacy).elements.map(e => e.marker), [1, 2]);
  for (const change of [{ page: 'https://secret:password@example.com/x' }, { page: 'https://example.com/x?token=secret' }, { html: '<script />' }, { frames: Array(17).fill('iframe') }, { image: { width: 4000, height: 20, scale: 1 } }]) assert.equal(isBrowserElementReference({ ...reference, ...change }), false);
});

test('capture rejects viewport/document races and requests CSS-scale pixels independently of DPR', async () => {
  const { captureElementSnapshot } = require('../../../packages/browser-agent/dist/element-snapshot');
  const viewport = { width: 400, height: 300, scrollX: 0, scrollY: 200, dpr: 2, scale: 1, x: 0, y: 0 };
  const locator = { boundingBox: async () => reference.target, evaluate: async () => 'Save' };
  const selection = { selector: reference.selector, frames: [], tag: 'button', documentId: reference.documentId };
  let current = true, changed = false;
  const page = { url: () => 'https://example.com/checkout?token=private#fragment', evaluate: async () => ({ ...viewport, scrollY: changed ? 300 : 200 }) };
  // Only a header is needed for the byte/geometry contract; real pixels are checked in native fixtures.
  const jpeg = Buffer.from([255,216,255,192,0,17,8,0,108,0,148,3,1,17,0,2,17,0,3,17,0]).toString('base64');
  const target = { send: async (method, options) => {
    if (method === 'Page.getLayoutMetrics') return { cssVisualViewport: { zoom: 1 } };
    assert.equal(options.clip.scale, .5); assert.deepEqual(options.clip, { ...reference.crop, y: 200, scale: .5 });
    return { data: jpeg };
  } };
  const snapshot = await captureElementSnapshot(page, locator, selection, 'tab-1', { x: 30, y: 40 }, () => current, target);
  assert.equal(snapshot.reference.page, 'https://example.com/checkout'); assert.equal(snapshot.reference.image.scale, 1);
  const privateLocator = { ...locator, evaluate: async callback => callback({ closest: () => ({}), getAttribute: () => null, textContent: 'private-textarea-value' }) };
  const privateSnapshot = await captureElementSnapshot(page, privateLocator, { ...selection, tag: 'textarea' }, 'tab-1', { x: 30, y: 40 }, () => current, target);
  assert.equal(privateSnapshot.reference.label, 'textarea · Selected element');
  assert.ok(!JSON.stringify(privateSnapshot.reference).includes('private-textarea-value'));
  const raced = { send: async (method, options) => { const result = await target.send(method, options); if (method === 'Page.captureScreenshot') changed = true; return result; } };
  await assert.rejects(captureElementSnapshot(page, locator, selection, 'tab-1', { x: 30, y: 40 }, () => current, raced), /changed/);
  changed = false;
  const revoked = { send: async (method, options) => { const result = await target.send(method, options); if (method === 'Page.captureScreenshot') current = false; return result; } };
  await assert.rejects(captureElementSnapshot(page, locator, selection, 'tab-1', { x: 30, y: 40 }, () => current, revoked), /changed/);
});

test('visual capture is an explicit optional viewer capability; old commands keep their shapes', () => {
  const { command } = require('../dist/browser/validation');
  assert.deepEqual(command({ kind: 'pick', enabled: true }), { kind: 'pick', enabled: true });
  assert.deepEqual(command({ kind: 'pick', enabled: true, visual: 1 }), { kind: 'pick', enabled: true, visual: 1 });
  assert.throws(() => command({ kind: 'feedback', enabled: true, visual: 1 }));
  assert.throws(() => command({ kind: 'pick', enabled: true, visual: 2 }));
});

test('a human pick cannot finish after its original viewport is resized or hidden', async () => {
  const { BrowserInteractionController } = require('../../../packages/browser-agent/dist');
  let pick, release, started;
  const ready = new Promise(resolve => { started = resolve; });
  const waiting = new Promise(resolve => { release = resolve; });
  const tab = { documentId: 'document-1', ownership: 1, viewportId: '1:true', picking: true,
    assertAgent() {}, takeOver() {}, handBack() {}, select() {}, pause() {}, picker(callback) { pick = callback; },
    target: async current => { started(); await waiting; if (current()) throw new Error('Accepted stale viewport'); throw new Error('Viewport changed'); },
  };
  const controller = new BrowserInteractionController({ tab: () => tab, authorize: async () => {}, changed() {} });
  const request = await controller.execute(2, { kind: 'request', tabId: 'tab-1', requestKind: 'element', message: 'Choose Save' });
  await controller.viewer('agent-request-pick', request.id, true);
  const pending = pick(10, 10); await ready; tab.viewportId = '2:false'; release();
  await assert.rejects(pending, /Viewport changed/);
  assert.equal(controller.pending[0].selection, undefined); controller.dispose();
});

test('remote ticket snapshots cannot substitute pixels from another tab', () => {
  const { browserHumanRequests } = require('../../../packages/browser-agent/dist');
  const selection = { selector: reference.selector, frames: [], tag: reference.tag, ...reference.target, documentId: reference.documentId, snapshot: { reference: { ...reference, tabId: 'other-tab' }, jpeg: '/9j/' } };
  assert.throws(() => browserHumanRequests([{ id: reference.id, tabId: 'tab-1', sessionId: 2, kind: 'element', message: 'Choose Save', status: 'completed', expiresAt: Date.now() + 10000, selection }]), /another tab/);
});
