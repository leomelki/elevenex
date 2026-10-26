import assert from 'node:assert/strict';

/** Run against desktop:preview with --url http://127.0.0.1:4310. */
export default async function* (capture) {
  await capture.waitFor(() => document.querySelector('ex-workspace-demo ex-diff-review'));
  await capture.reducedMotion(false);

  const layout = () => capture.evaluate(() => {
    const shell = document.querySelector('ex-app-shell');
    const rect = (selector) => {
      const { x, width } = shell.querySelector(selector).getBoundingClientRect();
      return { x, width };
    };
    return {
      panel: rect('.panel'),
      content: rect('.panel-inner'),
      chat: rect('.workspace > main'),
      rail: rect('.rail'),
      sidebar: rect('.sidebar'),
      inert: shell.querySelector('.panel').hasAttribute('inert'),
    };
  });
  const finish = () => capture.evaluate(() => {
    for (const animation of document.getAnimations()) {
      if (Number.isFinite(animation.effect?.getComputedTiming().endTime)) animation.finish();
    }
  });
  // Only seek live DOM animations: completed transitions from previous actions
  // must not be replayed when a new width transition starts.
  const seek = (time) => capture.evaluate((age) => {
    for (const animation of document.getAnimations()) {
      if (Number.isFinite(animation.effect?.getComputedTiming().endTime)) animation.currentTime = age;
    }
  }, time);

  for (const [theme, width] of [['light', 1600], ['dark', 960]]) {
    await capture.theme(theme);
    await capture.viewport(width, 1000);
    await finish();
    const normal = await layout();
    assert.ok(normal.panel.width > 0);
    await capture.motion.freeze();

    await capture.click('[aria-label="Wider review (⇧⌘R)"]');
    await finish();
    const wide = await layout();
    assert.ok(wide.panel.width > normal.panel.width);
    assert.equal(wide.chat.width, normal.chat.width);

    await capture.click('[aria-label="Leave wider review (⇧⌘R)"]');
    for (const time of [0, 70, 140, 210, 280]) {
      await seek(time);
      const frame = await layout();
      assert.ok(Math.abs(frame.panel.width - frame.content.width) < 1,
        `Review content must follow the panel at ${time}ms: ${JSON.stringify(frame)}`);
      assert.equal(frame.chat.width, normal.chat.width);
      assert.deepEqual(frame.rail, normal.rail);
      assert.deepEqual(frame.sidebar, normal.sidebar);
      if (time === 140) {
        assert.ok(frame.panel.width > normal.panel.width + 1);
        assert.ok(frame.panel.width < wide.panel.width - 1);
      }
      yield { name: `${theme}-review-collapse-${time}`, inspect: ['ex-app-shell .panel', '.panel-inner'] };
    }
    await finish();

    // Closing directly from wider review must also preserve the exiting content.
    await capture.click('[aria-label="Wider review (⇧⌘R)"]');
    await finish();
    await capture.click('[aria-label="Close side panel"]');
    for (const time of [0, 140, 280]) {
      await seek(time);
      const frame = await layout();
      assert.ok(Math.abs(frame.content.width - Math.max(frame.panel.width, normal.panel.width)) < 1);
      assert.equal(frame.inert, true);
      assert.deepEqual(frame.rail, normal.rail);
      assert.deepEqual(frame.sidebar, normal.sidebar);
      yield { name: `${theme}-close-wide-${time}`, inspect: ['ex-app-shell .panel', '.panel-inner'] };
    }
    await finish();
    assert.equal((await layout()).panel.width, 0);

    // Restore the normal panel via its public owning component for the next pass.
    await capture.component('ex-workspace-demo', component => component.panelOpen.set(true));
    await finish();
    await capture.motion.play();
  }

  await capture.reducedMotion(true);
  await capture.click('[aria-label="Wider review (⇧⌘R)"]');
  await capture.click('[aria-label="Leave wider review (⇧⌘R)"]');
  const reduced = await layout();
  assert.equal(reduced.content.width, reduced.panel.width);
  yield { name: 'reduced-motion-collapsed', inspect: ['ex-app-shell .panel', '.panel-inner'] };
}
