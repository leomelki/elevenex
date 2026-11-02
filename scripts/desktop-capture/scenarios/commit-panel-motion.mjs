import assert from 'node:assert/strict';

/** Loading geometry and the filled-exit cleanup boundary of the real commit popover. */
export default async function* (capture) {
  await capture.evaluate(() => { if (location.pathname !== '/connected-workspace') location.href = '/connected-workspace'; });
  await capture.waitFor(() => document.querySelector('ex-workspace-navigation ex-task-list'));
  await capture.component('ex-machine-workspace', component => component.store.selectSession({ taskId: '11', sessionId: '101' }));
  const finish = async () => {
    await capture.motion.finish(); await capture.motion.play(); await capture.settle();
  };
  const seek = async time => {
    await capture.evaluate(time => {
      for (const animation of document.querySelector('ex-commit-panel .commit-layer').getAnimations({ subtree: true })) {
        if (Number.isFinite(animation.effect?.getComputedTiming().endTime)) animation.currentTime = time;
      }
    }, time);
    await capture.settle();
  };
  for (const theme of ['light', 'dark']) {
    await capture.viewport(1440, 960); await capture.theme(theme); await capture.settle();
    await capture.waitFor(() => document.querySelector('ex-git-bar .primary')?.getAttribute('aria-label') === 'Commit 48');
    await capture.motion.freeze(); await capture.click('ex-git-bar .primary');
    await capture.waitFor(() => document.querySelector('ex-commit-panel .note') && !document.querySelector('ex-commit-panel .loading'));
    await seek(180);
    const geometry = await capture.evaluate(() => {
      const box = document.querySelector('ex-commit-panel .box');
      const shadow = document.querySelector('ex-commit-panel .ex-modal-shadow');
      const animation = box.getAnimations()[0];
      return { height: box.offsetHeight, shadowHeight: parseFloat(shadow.style.height), time: animation.currentTime };
    });
    assert.equal(geometry.shadowHeight, geometry.height, 'arriving preview content must resize the travelling box');
    assert.ok(Math.abs(geometry.time - 180) < .01, 'resize must preserve the animation clock');
    yield { name: `${theme}-opening`, inspect: ['ex-commit-panel .box', 'ex-commit-panel .ex-modal-shadow'], metadata: { geometry } };
    await seek(559);
    yield { name: `${theme}-entry-end`, inspect: ['ex-commit-panel .box'] };
    await finish();
    await capture.waitFor(() => document.activeElement?.matches('ex-commit-panel .message input'));
    await capture.fill('ex-commit-panel .message input', 'Preserve this draft');
    await capture.motion.freeze(); await capture.press('Escape'); await seek(220);
    assert.equal(await capture.evaluate(() => document.querySelector('ex-commit-panel .commit-layer').inert), true);
    yield { name: `${theme}-closing`, inspect: ['ex-commit-panel .box'] };
    const before = await capture.evaluate(() => {
      const style = getComputedStyle(document.querySelector('ex-commit-panel .box'));
      return { transform: style.transform, opacity: style.opacity, clip: style.clipPath };
    });
    await capture.click('ex-git-bar .primary');
    const after = await capture.evaluate(() => {
      const style = getComputedStyle(document.querySelector('ex-commit-panel .box'));
      return { transform: style.transform, opacity: style.opacity, clip: style.clipPath };
    });
    assert.deepEqual(after, before, 'reopening must start at the painted exit pose');
    assert.equal(await capture.evaluate(() => document.querySelector('ex-commit-panel .message input').value), 'Preserve this draft');
    await finish();
    await capture.motion.freeze(); await capture.press('Escape'); await seek(499);
    yield { name: `${theme}-exit-end`, inspect: ['ex-commit-panel .box'] };
    const cleanup = await capture.evaluate(async () => {
      const layer = document.querySelector('ex-commit-panel .commit-layer');
      const visibility = [];
      const cancel = window.Animation.prototype.cancel;
      window.Animation.prototype.cancel = function () {
        if (this.effect instanceof window.KeyframeEffect && layer.contains(this.effect.target)) visibility.push(getComputedStyle(layer).visibility);
        return cancel.call(this);
      };
      try {
        for (const animation of layer.getAnimations({ subtree: true })) {
          if (Number.isFinite(animation.effect?.getComputedTiming().endTime)) animation.finish();
        }
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return { visibility, removed: !layer.isConnected, focused: document.activeElement?.matches('ex-git-bar .primary') };
      } finally { window.Animation.prototype.cancel = cancel; }
    });
    assert.ok(cleanup.visibility.length > 0);
    assert.ok(cleanup.visibility.every(value => value === 'hidden'), 'the full-size panel must be hidden before its exit animations are cancelled');
    assert.equal(cleanup.removed, true); assert.equal(cleanup.focused, true);
    await capture.motion.play();
    yield { name: `${theme}-closed`, inspect: ['ex-git-bar .primary'], metadata: { cleanup } };
    // A new opening after complete disposal must not inherit hidden visibility.
    await capture.reducedMotion(true); await capture.viewport(1040, 760);
    await capture.click('ex-git-bar .primary'); await capture.settle();
    await capture.waitFor(() => document.querySelector('ex-commit-panel .note') && document.activeElement?.matches('ex-commit-panel .message input'));
    await finish();
    assert.equal(await capture.evaluate(() => getComputedStyle(document.querySelector('ex-commit-panel .commit-layer')).visibility), 'visible');
    yield { name: `${theme}-narrow-reduced`, inspect: ['ex-commit-panel .box'] };
    await capture.press('Escape');
    await capture.waitFor(() => !document.querySelector('ex-commit-panel .commit-layer'));
    await capture.reducedMotion(false);
  }
}
