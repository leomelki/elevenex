import assert from 'node:assert/strict';

export default async function* (capture) {
  await capture.evaluate(() => { location.href = '/conversation'; });
  const trigger = '.image-preview-demo button.image';
  await capture.waitFor(() => document.querySelector('.image-preview-demo img')?.complete);
  const settled = async () => {
    await capture.settle();
    await capture.waitFor(() => document.getAnimations().every(animation =>
      !Number.isFinite(animation.effect?.getComputedTiming().endTime) || animation.playState !== 'running'));
  };
  const open = async () => {
    await capture.evaluate(selector => document.querySelector(selector).scrollIntoView({ block: 'center' }), trigger);
    await capture.click(trigger);
    await capture.waitFor(() => document.querySelector('.image-viewer .picture.ready'));
  };
  const closed = async () => {
    await capture.waitFor(() => !document.querySelector('.image-viewer'));
    assert.equal(await capture.evaluate(selector => document.activeElement === document.querySelector(selector), trigger), true);
  };
  // Seek live modal objects only: the long gallery also has transient chat animations.
  const seek = async time => {
    await capture.evaluate(time => {
      for (const animation of document.getAnimations()) {
        const target = animation.effect?.target;
        if (target?.closest?.('.ex-modal-layer') && Number.isFinite(animation.effect.getComputedTiming().endTime)) animation.currentTime = time;
      }
    }, time);
    await capture.settle();
  };
  for (const theme of ['light', 'dark']) {
    await capture.theme(theme); await capture.viewport(1440, 960); await capture.reducedMotion(false);
    await capture.motion.freeze(); await open();
    for (const time of [0, 140, 280, 560]) {
      await seek(time);
      yield { name: `${theme}-opening-${time}ms`, inspect: ['.image-viewer'], metadata: { animationTimeMs: time } };
    }
    await capture.motion.finish(); await capture.motion.play(); await settled();
    assert.equal(await capture.evaluate(() => document.activeElement?.matches('.image-viewer .close button')), true);
    assert.equal(await capture.evaluate(() => document.querySelector('.image-viewer header').textContent.trim()), 'Workspace illustration');
    yield { name: theme + '-fit', inspect: ['.image-viewer', '.picture', '.image-viewer .viewport'] };
    await capture.press('Tab');
    assert.equal(await capture.evaluate(() => document.activeElement?.matches('.image-viewer .picture')), true);
    await capture.press('Enter'); await settled();
    assert.equal(await capture.evaluate(() => document.querySelector('.zoom-value').textContent), '100%');
    for (let index = 0; index < 8; index++) await capture.press('+');
    assert.equal(await capture.evaluate(() => document.querySelector('.zoom-value').textContent), '300%');
    assert.equal(await capture.evaluate(() => document.querySelector('.image-viewer [aria-label="Zoom in"]').disabled), true);
    // Trusted drag on the enlarged image must pan without toggling zoom or dismissing.
    const point = await capture.evaluate(() => {
      const rect = document.querySelector('.image-viewer .viewport').getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    });
    await capture.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1 });
    await capture.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x + 100, y: point.y + 60, button: 'left', buttons: 1 });
    await capture.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x + 100, y: point.y + 60, button: 'left', buttons: 0, clickCount: 1 });
    assert.equal(await capture.evaluate(() => document.querySelector('.zoom-value').textContent), '300%');
    assert.equal(await capture.evaluate(() => document.querySelector('.picture').style.transform.includes('translate(100px, 60px)')), true);
    yield { name: theme + '-zoomed', inspect: ['.image-viewer', '.picture'] };
    await capture.press('0');
    assert.equal(await capture.evaluate(() => document.querySelector('.zoom-value').textContent), 'Fit');
    await capture.click('.image-viewer header h2');
    assert.equal(await capture.evaluate(() => !!document.querySelector('.image-viewer')), true);
    yield { name: theme + '-viewer', inspect: ['.image-viewer', '.zoom'] };
    // Blank canvas dismisses, as does the outer modal backdrop.
    const blank = await capture.evaluate(() => {
      const rect = document.querySelector('.image-viewer .viewport').getBoundingClientRect();
      return { x: Math.round(rect.left + 4), y: Math.round(rect.top + 4) };
    });
    await capture.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', ...blank, button: 'left', clickCount: 1 });
    await capture.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', ...blank, button: 'left', clickCount: 1 });
    await closed();
    await open(); await settled();
    await capture.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: 4, y: 4, button: 'left', clickCount: 1 });
    await capture.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 4, y: 4, button: 'left', clickCount: 1 });
    await closed();
    await open(); await settled();
    await capture.press('Tab', 8);
    assert.equal(await capture.evaluate(() => !!document.activeElement?.closest('.image-viewer')), true);
    await capture.press('Escape'); await closed();

    // A close during entry retains the same surface until the reverse motion ends.
    await capture.motion.freeze(); await open(); await seek(180);
    await capture.press('Escape'); await seek(100);
    assert.equal(await capture.evaluate(() => !!document.querySelector('.ex-modal-layer[inert] .image-viewer')), true);
    yield { name: theme + '-interrupted-exit', inspect: ['.image-viewer', '.ex-modal-layer'] };
    await capture.motion.finish(); await capture.motion.play(); await closed();

    await open(); await settled();
    await capture.component('ex-image-viewer', component => component.loading.set(true));
    yield { name: theme + '-loading', inspect: ['.image-viewer', '.image-viewer [role="status"]'] };
    assert.equal(await capture.evaluate(() => document.querySelector('.image-viewer [aria-label="Zoom in"]').disabled), true);
    await capture.component('ex-image-viewer', component => { component.loading.set(false); component.failed.set(true); });
    yield { name: theme + '-unavailable', inspect: ['.image-viewer', '.image-viewer [role="status"]'] };
    await capture.click('.image-viewer .close'); await closed();

    await capture.component('ex-conversation-demo', component => component.imageShape.set('portrait'));
    await capture.viewport(420, 600); await capture.reducedMotion(true); await open(); await settled();
    const contained = await capture.evaluate(() => {
      const box = document.querySelector('.image-viewer').getBoundingClientRect();
      const image = document.querySelector('.picture').getBoundingClientRect();
      return box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight
        && image.top >= box.top && image.bottom <= box.bottom;
    });
    assert.equal(contained, true);
    yield { name: theme + '-portrait-narrow-reduced', inspect: ['.image-viewer', '.picture'] };
    await capture.click('.image-viewer .close'); await closed();
    await capture.component('ex-conversation-demo', component => component.imageShape.set('small'));
    await capture.viewport(420, 360); await open(); await settled();
    yield { name: theme + '-small-short-reduced', inspect: ['.image-viewer', '.picture', '.zoom'] };
    await capture.click('.image-viewer .close'); await closed();
    await capture.component('ex-conversation-demo', component => component.imageShape.set('landscape'));
  }
}
