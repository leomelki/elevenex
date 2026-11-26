import assert from 'node:assert/strict';

export default async function* panelResize(capture) {
  const handle = '[aria-label="Resize side panel"]';
  const panel = 'ex-app-shell .panel';
  const toggle = 'ex-workspace-task-header [aria-label="Toggle side panel"]';
  const finish = async () => {
    await capture.waitFor(() => document.getAnimations().every(animation =>
      !Number.isFinite(animation.effect?.getComputedTiming().endTime) || animation.playState !== 'running'));
    await capture.settle();
  };
  const width = () => capture.evaluate(panel => document.querySelector(panel).clientWidth, panel);
  const mouse = (type, x, y) => capture.cdp('Input.dispatchMouseEvent', {
    type, x, y, button: 'left',
    buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1,
  });
  await capture.viewport(1440, 900);
  await capture.cdp('Emulation.setFocusEmulationEnabled', { enabled: true });
  await capture.evaluate(() => { location.href = '/connected-workspace'; });
  await capture.waitFor(() => document.querySelector('ex-workspace-navigation ex-task-list'));
  await capture.component('ex-machine-workspace', component => component.store.selectSession({ taskId: '11', sessionId: '101' }));
  await capture.waitFor(() => document.querySelector('ex-chat ex-turn'));
  await capture.click(toggle);
  await finish();
  assert.equal(await width(), 440);

  const startDrag = async () => {
    const bounds = await capture.rect(handle);
    const x = Math.round(bounds.x + bounds.width / 2);
    const y = Math.round(bounds.y + bounds.height / 2);
    await capture.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await mouse('mousePressed', x, y);
    await capture.waitFor(() => document.querySelector('ex-app-shell').classList.contains('panel-resizing'));
    return { x, y };
  };
  let { x, y } = await startDrag();
  await mouse('mouseMoved', x - 144, y);
  await capture.waitFor(() => document.querySelector('ex-app-shell .panel').clientWidth === 584);
  assert.equal(await capture.evaluate(() => document.querySelector('ex-app-shell .panel').getAnimations().length), 0);
  yield { name: 'light-dragging', inspect: [handle, panel, 'ex-app-shell main'] };
  await mouse('mouseReleased', x - 144, y);
  await finish();
  assert.equal(await width(), 584);
  assert.equal(await capture.evaluate(() => document.activeElement?.getAttribute('role')), 'separator');

  ({ x, y } = await startDrag());
  await mouse('mouseMoved', x + 500, y);
  await capture.waitFor(() => document.querySelector('ex-app-shell .panel').clientWidth === 320);
  await capture.press('Escape');
  await mouse('mouseReleased', x + 500, y);
  await finish();
  assert.equal(await width(), 584);
  assert.equal(await capture.evaluate(() => document.querySelector('ex-app-shell').classList.contains('panel-resizing')), false);
  await capture.press('ArrowRight');
  await finish();
  assert.equal(await width(), 568);

  await capture.theme('dark');
  await capture.reducedMotion(true);
  await capture.press('End');
  const maximum = await capture.evaluate(() => Number(document.querySelector('[role="separator"]').getAttribute('aria-valuemax')));
  assert.equal(await width(), maximum);
  assert.ok((await capture.rect('ex-app-shell main')).width >= 360);
  yield { name: 'dark-keyboard-maximum', inspect: [handle, panel, 'ex-app-shell main'] };
  await capture.click(toggle);
  await finish();
  assert.equal(await width(), 0);
  assert.equal(await capture.evaluate(() => !!document.querySelector('[aria-label="Resize side panel"]')), false);
  await capture.click(toggle);
  await finish();
  assert.equal(await width(), maximum);
  await capture.viewport(880, 850);
  await finish();
  assert.ok(await width() < maximum);
  assert.ok((await capture.rect('ex-app-shell main')).width >= 220);
  await capture.viewport(640, 850);
  await finish();
  assert.equal(await capture.evaluate(() => document.querySelector('ex-app-shell main').inert &&
    !document.querySelector('[aria-label="Resize side panel"]')), true);
  yield { name: 'dark-compact-takeover', inspect: [panel, 'ex-app-shell main'] };
  await capture.viewport(1440, 900);
  await finish();
  assert.equal(await width(), maximum);
  await capture.click(handle);
  await capture.press('Enter');
  assert.equal(await width(), 440);
}
