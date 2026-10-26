import assert from 'node:assert/strict';

/** Run with --fixture. Exercises real Angular signals, input, IPC and motion. */
export default async function* (capture) {
  const preferences = capture.window.webContents.getLastWebPreferences();
  assert.equal(preferences.contextIsolation, true);
  assert.equal(preferences.nodeIntegration, false);
  assert.equal(preferences.sandbox, true);
  assert.equal(preferences.webSecurity, true);
  await capture.waitFor(() => document.querySelector('ex-capture-fixture h1'));
  const bridge = await capture.evaluate(async () => ({
    node: typeof window.require,
    keys: Object.keys(window.elevenex).sort(),
    status: await window.elevenex.gitStatus('/capture/fixture'),
  }));
  assert.equal(bridge.node, 'undefined');
  assert.deepEqual(bridge.keys, ['appVersion', 'gitStatus', 'onThemeChanged', 'platform']);
  assert.equal(bridge.status.mock, true);
  yield { name: 'ready-light', inspect: ['#panel', '#increment'] };

  await capture.component('ex-capture-fixture', (component, data) => {
    component.count.set(data.count);
    component.status.set(data.status);
  }, { count: 42, status: 'Needs you' });
  await capture.click('#increment');
  await capture.waitFor(() => document.querySelector('[role=status]').textContent.includes('43'));
  await capture.fill('#message', 'Trusted input 🐘');
  assert.equal(await capture.evaluate(() => document.querySelector('#message').value), 'Trusted input 🐘');
  await capture.press('Tab');
  assert.equal(await capture.evaluate(() => document.activeElement.id), 'increment');
  await assert.rejects(() => capture.click('button:disabled'), /disabled/);
  await assert.rejects(() => capture.click('button'), /Expected one/);
  yield { name: 'seeded-and-focused', inspect: ['[role=status]', '#message', '#increment'] };

  await capture.motion.freeze();
  await capture.click('#toggle');
  await capture.motion.seek(0);
  const initial = await capture.inspect(['#panel']);
  const startOpacity = Number(initial.elements['#panel'][0].style.opacity);
  assert.ok(startOpacity < 0.05, `Frozen transition starts at zero, got ${startOpacity}`);
  await capture.motion.seek(500);
  const middle = await capture.inspect(['#panel']);
  const opacity = Number(middle.elements['#panel'][0].style.opacity);
  assert.ok(opacity > 0.45 && opacity < 0.55, `Expected half opacity, got ${opacity}`);
  yield { name: 'panel-halfway', inspect: ['#panel'], metadata: { timeMs: 500 } };
  // Captures and settling must not advance paused animation time.
  await capture.settle();
  const frozen = await capture.inspect(['#panel']);
  assert.equal(frozen.elements['#panel'][0].style.opacity, middle.elements['#panel'][0].style.opacity);
  yield* capture.frames('panel', [750, 1000], ['#panel']);
  await capture.motion.finish();
  await capture.theme('dark');
  await capture.reducedMotion(true);
  await capture.click('#toggle');
  const reduced = await capture.inspect(['#panel']);
  assert.equal(reduced.media.dark, true);
  assert.equal(reduced.media.reducedMotion, true);
  assert.equal(reduced.elements['#panel'][0].style.opacity, '0');
  yield { name: 'dark-reduced-motion', inspect: ['#panel'] };
  await capture.viewport(900, 700);
  yield { name: 'cropped-controls', selector: 'main', inspect: ['main'] };
  await capture.reducedMotion(false);
  await capture.evaluate(() => {
    document.querySelector('#message').animate([{ opacity: 0 }, { opacity: 1 }], { duration: 400, fill: 'both' });
  });
  await capture.motion.seek(200);
  const waapi = await capture.inspect(['#message']);
  assert.equal(waapi.elements['#message'][0].style.opacity, '0.5');
  yield { name: 'waapi-halfway', inspect: ['#message'] };
  await capture.motion.finish();
  await capture.motion.play();
  const probe = await capture.measureMotion(['#message'], 100);
  assert.ok(probe.samples.length >= 2);
  assert.equal(probe.maxShift, 0);
  // Raw trusted input remains available for shortcuts, wheel, drag and touch.
  await capture.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 });
}
