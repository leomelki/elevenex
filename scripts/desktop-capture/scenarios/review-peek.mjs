import assert from 'node:assert/strict';

/**
 * Wider review leaves the receded chat's edge in view; pressing it returns.
 * Run against desktop:preview with --url http://127.0.0.1:4310.
 */
export default async function* (capture) {
  await capture.waitFor(() => document.querySelector('ex-workspace-demo ex-diff-review'));
  await capture.reducedMotion(false);

  const state = () => capture.evaluate(() => {
    const shell = document.querySelector('ex-app-shell');
    const box = (element) => { const { x, y, width, height } = element.getBoundingClientRect(); return { x, y, width, height }; };
    const main = shell.querySelector('.workspace > main'), peek = shell.querySelector('.peek');
    return {
      wide: shell.classList.contains('wide-review'),
      workspace: box(shell.querySelector('.workspace')),
      panel: box(shell.querySelector('.panel')),
      chat: box(main),
      chatOpacity: Number(getComputedStyle(main).opacity),
      chatInert: main.hasAttribute('inert'),
      peek: box(peek),
      peekInert: peek.hasAttribute('inert'),
      peekVisible: getComputedStyle(peek).visibility === 'visible',
      focused: document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName ?? null,
    };
  });
  const finish = () => capture.evaluate(() => {
    for (const animation of document.getAnimations()) {
      if (Number.isFinite(animation.effect?.getComputedTiming().endTime)) animation.finish();
    }
  });
  const seek = (time) => capture.evaluate((age) => {
    for (const animation of document.getAnimations()) {
      if (Number.isFinite(animation.effect?.getComputedTiming().endTime)) animation.currentTime = age;
    }
  }, time);
  const inspect = ['ex-app-shell .workspace > main', 'ex-app-shell .peek', 'ex-app-shell .grabber', 'ex-app-shell .panel'];

  for (const [theme, width] of [['light', 1600], ['dark', 1100]]) {
    await capture.theme(theme);
    await capture.viewport(width, 1000);
    await capture.component('ex-workspace-demo', component => { component.panelOpen.set(true); component.wide.set(false); });
    await finish();
    const normal = await state();
    assert.equal(normal.peekInert, true);
    assert.equal(normal.peekVisible, false);

    await capture.motion.freeze();
    await capture.click('[aria-label="Wider review (⇧⌘R)"]');
    for (const time of [0, 140, 280]) {
      await seek(time);
      yield { name: `${theme}-peek-enter-${time}`, inspect };
    }
    await finish();
    const wide = await state();
    assert.equal(wide.wide, true);
    assert.equal(wide.chatInert, true);
    assert.equal(wide.peekInert, false);
    // The panel stops short of the chat's edge, which stays visible and receded.
    assert.ok(wide.panel.x - wide.workspace.x >= 40 && wide.panel.x - wide.workspace.x <= 56, JSON.stringify(wide));
    assert.ok(wide.peek.x + wide.peek.width <= wide.panel.x, JSON.stringify(wide));
    assert.ok(wide.chatOpacity > 0.3 && wide.chatOpacity < 0.8);
    assert.ok(wide.chat.height < normal.chat.height, 'The chat recedes while a review takes over');
    yield { name: `${theme}-peek-rest`, inspect };

    await capture.motion.play();
    await capture.hover('ex-app-shell .peek');
    await capture.motion.freeze();
    await finish();
    const hovered = await state();
    assert.ok(hovered.chatOpacity > wide.chatOpacity, 'The chat leans forward under the pointer');
    yield { name: `${theme}-peek-hover`, inspect };

    await capture.click('ex-app-shell .peek');
    for (const time of [0, 140, 280]) {
      await seek(time);
      const frame = await state();
      assert.equal(frame.wide, false);
      assert.equal(frame.peekInert, true);
      yield { name: `${theme}-peek-return-${time}`, inspect };
    }
    await finish();
    const returned = await state();
    assert.deepEqual(returned.panel, normal.panel);
    assert.deepEqual(returned.chat, normal.chat);
    assert.equal(returned.chatOpacity, 1);
    assert.equal(returned.chatInert, false);
    await capture.motion.play();
  }

  // Keyboard: the peek is a labelled control just before the review in tab order.
  await capture.click('[aria-label="Wider review (⇧⌘R)"]');
  await finish();
  await capture.evaluate(() => document.querySelector('ex-app-shell .panel').querySelector('button:not(:disabled)').focus());
  await capture.press('Tab', 8);
  assert.equal((await state()).focused, 'Return to chat');
  yield { name: 'dark-peek-focus', inspect };
  await capture.press('Enter');
  await finish();
  assert.equal((await state()).wide, false);

  // Compact: an open panel takes over, and the peek closes it.
  await capture.theme('light');
  await capture.viewport(680, 900);
  await capture.component('ex-workspace-demo', component => component.panelOpen.set(true));
  await finish();
  const compact = await state();
  assert.equal(compact.wide, true);
  assert.equal(compact.peekInert, false);
  yield { name: 'light-compact-peek', inspect };
  await capture.click('ex-app-shell .peek');
  await finish();
  assert.equal((await state()).panel.width, 0);

  // Reduced motion applies the takeover and the return at once.
  await capture.reducedMotion(true);
  await capture.viewport(1300, 900);
  await capture.component('ex-workspace-demo', component => component.panelOpen.set(true));
  await capture.click('[aria-label="Wider review (⇧⌘R)"]');
  const reduced = await state();
  assert.equal(reduced.wide, true);
  yield { name: 'reduced-motion-peek', inspect };
  await capture.click('ex-app-shell .peek');
  assert.equal((await state()).wide, false);
}
