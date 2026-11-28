import assert from 'node:assert/strict';

// Supplied machine data stays in the isolated preview; no production test hooks.
export default async function* (capture) {
  await capture.viewport(1240, 1000);
  await capture.evaluate(() => document.querySelector('a[href="/machines"]').scrollIntoView());
  await capture.click('a[href="/machines"]');
  await capture.waitFor(() => document.querySelector('ex-title-island-demo'));
  await capture.evaluate(() => document.querySelector('ex-title-island-demo').scrollIntoView({ block: 'center' }));
  const root = 'ex-title-island-demo';
  const shell = `${root} ex-title-island > .island`;
  const choose = state => capture.click(`${root} [data-island-state="${state}"]`);
  const geometry = () => capture.evaluate(() => {
    const root = document.querySelector('ex-title-island-demo');
    const island = root.querySelector('ex-title-island > .island');
    const content = island.querySelector('.content');
    const bar = root.querySelector('ex-title-bar').getBoundingClientRect();
    const box = island.getBoundingClientRect();
    const eventAction = root.querySelector('ex-island-event button')?.getBoundingClientRect();
    const name = root.querySelector('ex-island-name .name');
    return {
      width: box.width, height: box.height, top: box.top - bar.top,
      centerOffset: box.x + box.width / 2 - bar.x - bar.width / 2,
      withinBar: box.x >= bar.x && box.right <= bar.right,
      contentOpacity: Number(getComputedStyle(content).opacity),
      contentAnimations: content.getAnimations().filter(animation => animation.playState !== 'finished').length,
      eventActionVisible: !eventAction || (eventAction.x >= box.x && eventAction.right <= box.right),
      nameTruncated: !!name && name.scrollWidth > name.clientWidth,
      activeInside: !!root.querySelector('[role="dialog"]')?.contains(document.activeElement),
      triggerFocused: document.activeElement === root.querySelector('.trigger'),
      tone: island.dataset.tone,
    };
  });
  const aligned = value => {
    assert.ok(Math.abs(value.centerOffset) < 1, 'The pill remains centered in its own title bar');
    assert.equal(value.top, 5, 'Every state keeps the title-bar top anchor');
    assert.equal(value.withinBar, true, 'The pill fits its containing title bar');
    assert.equal(value.eventActionVisible, true, 'Long event text never hides its action');
  };
  const seek = age => capture.evaluate(time => {
    const island = document.querySelector('ex-title-island-demo ex-title-island > .island');
    for (const animation of island.getAnimations({ subtree: true })) {
      if (Number.isFinite(animation.effect?.getComputedTiming().endTime)) animation.currentTime = time;
    }
  }, age);

  for (const theme of ['light', 'dark']) {
    await capture.theme(theme);
    await capture.viewport(1240, 1000);
    await capture.component(root, component => {
      component.machine.set({ id: 'local', name: 'This Mac', kind: 'local', address: 'MacBook Pro · 1.6.0', conn: 'live', color: 'pine' });
      component.guestName.set('Leo’s MacBook Pro');
      component.guests.set(0);
      component.disabled.set(false);
      component.highlight.set(undefined);
      component.progress.set(.56);
      component.select('name');
    });
    await capture.motion.finish();
    for (const [state, tone] of [['name', 'rest'], ['guest', 'info'], ['lost', 'warn'], ['back', 'ok'], ['update', 'info']]) {
      await choose(state);
      await capture.motion.finish();
      const value = await geometry();
      aligned(value);
      assert.equal(value.tone, tone);
      assert.equal(value.contentOpacity, 1);
      assert.equal(value.contentAnimations, 0);
      if (state !== 'guest') assert.equal(value.height, 24);
      yield { name: `${theme}-${state}`, selector: root, inspect: [shell], metadata: value };
    }

    // Progress ticks animate only the line. The same content key stays readable.
    await capture.motion.freeze();
    await capture.component(root, component => component.progress.set(.82));
    const progress = () => capture.evaluate(() => {
      const node = document.querySelector('ex-title-island-demo [role="progressbar"]');
      return { value: node.getAttribute('aria-valuenow'), scale: new window.DOMMatrix(getComputedStyle(node).transform).a };
    });
    await seek(0);
    assert.ok(Math.abs((await progress()).scale - .56) < .01);
    await seek(100);
    assert.ok(Math.abs((await progress()).scale - .69) < .01);
    assert.equal((await geometry()).contentOpacity, 1);
    assert.equal((await geometry()).contentAnimations, 0);
    yield { name: `${theme}-progress-midpoint`, selector: root, inspect: [`${root} [role="progressbar"]`] };
    await capture.motion.finish();
    assert.equal((await progress()).value, '82');
    for (const [value, expected] of [[-1, '0'], [2, '100']]) {
      await capture.component(root, (component, value) => component.progress.set(value), value);
      assert.equal((await progress()).value, expected);
    }
    await capture.motion.play();

    for (const kind of ['local', 'ssh', 'peer']) {
      await capture.component(root, (component, kind) => {
        component.machine.update(machine => ({ ...machine, kind }));
        component.guests.set(0);
        component.select('open');
      }, kind);
      await capture.motion.finish();
      aligned(await geometry());
      assert.equal((await geometry()).activeInside, true);
      const buttons = await capture.evaluate(() => [...document.querySelectorAll('ex-title-island-demo [role="dialog"] button')].map(node => (node.querySelector('b') ?? node).textContent.trim()));
      assert.deepEqual(buttons, kind === 'ssh' ? ['Change', 'Disconnect', 'New window'] : ['Change', 'New window']);
      yield { name: `${theme}-${kind}-panel`, selector: root, inspect: [`${root} [role="dialog"]`] };
      await capture.press('Escape');
      await capture.motion.finish();
      assert.equal((await geometry()).triggerFocused, true);
    }
    await capture.component(root, component => { component.guests.set(1); component.select('open'); });
    await capture.motion.finish();
    yield { name: `${theme}-guest-panel`, selector: root, inspect: [`${root} [role="dialog"]`] };
    for (const highlight of ['change', 'new']) {
      await capture.component(root, (component, highlight) => component.highlight.set(highlight), highlight);
      await capture.motion.finish();
      yield { name: `${theme}-highlight-${highlight}`, selector: root, inspect: [`${root} .highlighted`] };
    }
    await capture.hover(`${root} .new-window`);
    await capture.motion.finish();
    yield { name: `${theme}-panel-hover`, selector: root, inspect: [`${root} .new-window`] };
    await capture.component(root, component => { component.highlight.set(undefined); component.disabled.set(true); });
    assert.equal(await capture.evaluate(() => [...document.querySelectorAll('ex-title-island-demo [role="dialog"] button')].every(button => button.disabled)), true);
    assert.equal((await geometry()).activeInside, true);
    await capture.press('Tab');
    assert.equal((await geometry()).activeInside, true, 'A panel with no enabled actions still traps keyboard focus');
    yield { name: `${theme}-panel-disabled`, selector: root, inspect: [`${root} [role="dialog"] button`] };
    await capture.component(root, component => component.disabled.set(false));

    // Dismissal must respect the destination of an outside pointer click.
    await choose('back');
    await capture.motion.finish();
    assert.equal(await capture.evaluate(() => document.activeElement.matches('ex-title-island-demo [data-island-state="back"]')), true);
    assert.equal(await capture.evaluate(() => !!document.querySelector('ex-title-island-demo [role="dialog"]')), false);
    yield { name: `${theme}-outside-focus`, selector: root };

    // Verify action keyboard input independently of the sibling machine trigger.
    await choose('guest');
    await capture.motion.finish();
    await capture.click(`${root} .trigger`);
    await capture.motion.finish();
    await capture.press('Escape');
    await capture.motion.finish();
    await choose('guest');
    await capture.motion.finish();
    await capture.evaluate(() => document.querySelector('ex-title-island-demo .trigger').focus());
    await capture.press('Tab');
    assert.equal(await capture.evaluate(() => document.activeElement.matches('ex-title-island-demo ex-island-event button')), true);
    // Include the native Enter character so Chromium performs button activation.
    await capture.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
    await capture.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await capture.settle();
    await capture.motion.finish();
    assert.equal(await capture.evaluate(() => !!document.querySelector('ex-title-island-demo [role="dialog"]')), false);
    assert.equal(await capture.component(root, component => component.guests()), 0);

    await capture.component(root, component => {
      component.machine.update(machine => ({ ...machine, name: 'production-server-with-a-very-long-machine-name' }));
      component.guestName.set('Studio-MacBook-Pro-with-a-very-long-computer-name');
      component.select('guest');
    });
    for (const width of [640, 400]) {
      await capture.viewport(width, 1000);
      await capture.settle();
      await capture.motion.finish();
      aligned(await geometry());
      yield { name: `${theme}-long-event-${width}`, selector: root, metadata: await geometry() };
      await choose('name');
      await capture.motion.finish();
      aligned(await geometry());
      assert.equal((await geometry()).nameTruncated, true);
      yield { name: `${theme}-long-name-${width}`, selector: root, metadata: await geometry() };
      await choose('open');
      await capture.motion.finish();
      aligned(await geometry());
      yield { name: `${theme}-long-panel-${width}`, selector: root, metadata: await geometry() };
      await capture.press('Escape');
      await choose('guest');
      await capture.motion.finish();
    }
  }
}
