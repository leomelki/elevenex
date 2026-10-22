import assert from 'node:assert/strict';

// Run against the isolated component preview: --url http://127.0.0.1:4315.
export default async function* (capture) {
  await capture.viewport(1240, 1000);
  await capture.click('a[href="/machines"]');
  await capture.waitFor(() => document.querySelector('ex-title-island-demo'));
  await capture.evaluate(() => document.querySelector('ex-title-island-demo').scrollIntoView({ block: 'center' }));
  const root = 'ex-title-island-demo';
  const shell = `${root} ex-title-island > .island`;
  const content = `${root} .content`;
  const trigger = `${root} .trigger`;
  const choose = state => capture.click(`${root} [data-island-state="${state}"]`);
  // Sample only current island animations. CDP retains completed transitions
  // from earlier actions; seeking those would replay an obsolete pill size.
  const seek = async age => {
    await capture.evaluate(time => {
      const island = document.querySelector('ex-title-island-demo ex-title-island > .island');
      for (const animation of island.getAnimations({ subtree: true })) {
        if (Number.isFinite(animation.effect?.getComputedTiming().endTime)) animation.currentTime = time;
      }
    }, age);
    await capture.settle();
  };
  const geometry = () => capture.evaluate(() => {
    const island = document.querySelector('ex-title-island-demo ex-title-island > .island');
    const content = island.querySelector('.content');
    const box = island.getBoundingClientRect();
    return {
      width: box.width, height: box.height, top: box.top, center: box.x + box.width / 2,
      targetWidth: content.offsetWidth, targetHeight: content.offsetHeight,
      opacity: Number(getComputedStyle(content).opacity),
      animations: island.getAnimations({ subtree: true }).filter(animation => animation.playState !== 'finished').length,
      activeInside: !!island.querySelector('.details')?.contains(document.activeElement),
    };
  });
  for (const theme of ['light', 'dark']) {
    await capture.theme(theme);
    await choose('name');
    await capture.motion.finish();
    const rest = await geometry();
    assert.equal(rest.height, 24);
    yield { name: `${theme}-resting`, selector: root, inspect: [shell, content, trigger] };
    await capture.motion.freeze();
    await choose('guest');
    await seek(0);
    const initial = await geometry();
    assert.ok(Math.abs(initial.width - rest.width) < 1, 'Expansion starts at the current pill width');
    assert.ok(initial.targetWidth > rest.width + 80);
    assert.equal(initial.opacity, 0, 'Incoming content waits for the shell');
    yield { name: `${theme}-guest-start`, selector: root, inspect: [shell, content] };
    await seek(60);
    const early = await geometry();
    assert.ok(early.width > rest.width && early.width < early.targetWidth, 'Shell grows before the text enters');
    assert.ok(early.opacity < .05);
    yield { name: `${theme}-guest-60ms`, selector: root, inspect: [shell, content] };
    await seek(180);
    const spring = await geometry();
    assert.ok(spring.width > spring.targetWidth, 'The designed spring overshoots');
    assert.ok(Math.abs(spring.center - rest.center) < 1, 'The island stays centered');
    assert.ok(Math.abs(spring.top - rest.top) < 1, 'The top anchor stays fixed');
    yield { name: `${theme}-guest-spring`, selector: root, inspect: [shell, content] };
    await capture.motion.finish();
    const guest = await geometry();
    assert.ok(Math.abs(guest.width - guest.targetWidth) < 1);
    assert.ok(Math.abs(guest.height - guest.targetHeight) < 1);
    assert.ok(guest.height > rest.height);
    yield { name: `${theme}-guest`, selector: root, inspect: [shell] };

    // Interrupt a contraction, immediately expand again, and keep the latest news.
    await choose('lost');
    await seek(60);
    await choose('back');
    await seek(120);
    await choose('guest');
    await capture.motion.finish();
    await capture.waitFor(() => document.querySelector('ex-title-island-demo ex-island-event'));
    // Its action must work without activating the sibling machine trigger.
    await capture.click(`${root} ex-island-event button`);
    await capture.motion.finish();
    assert.equal(await capture.evaluate(() => !!document.querySelector('ex-title-island-demo [role="dialog"]')), false);

    await capture.click(trigger);
    await seek(120);
    yield { name: `${theme}-panel-opening`, selector: root, inspect: [shell, content, '[role="dialog"]'] };
    await capture.motion.finish();
    assert.equal((await geometry()).activeInside, true);
    await capture.press('Tab', 8);
    assert.equal(await capture.evaluate(() => document.activeElement.matches('ex-title-island-demo .new-window')), true);
    await capture.press('Tab');
    assert.equal(await capture.evaluate(() => document.activeElement.textContent.trim()), 'Change');
    yield { name: `${theme}-panel`, selector: root, inspect: [shell, '[role="dialog"]'] };
    await capture.press('Escape');
    await capture.motion.finish();
    assert.equal(await capture.evaluate(() => document.activeElement === document.querySelector('ex-title-island-demo .trigger')), true);
    yield { name: `${theme}-keyboard-focus`, selector: root, inspect: [trigger] };

    await choose('update');
    await capture.motion.finish();
    await capture.component(root, component => component.progress.set(.82));
    await capture.motion.finish();
    assert.equal(await capture.evaluate(() => document.querySelector('ex-title-island-demo [role="progressbar"]').getAttribute('aria-valuenow')), '82');
    yield { name: `${theme}-updating`, selector: root, inspect: [`${root} [role="progressbar"]`] };
    await capture.motion.play();
  }
  await capture.motion.freeze();
  await choose('guest');
  await seek(60);
  await capture.reducedMotion(true);
  await capture.motion.play();
  await capture.settle();
  assert.equal((await geometry()).animations, 0, 'Changing the motion preference cancels in-flight movement');
  await choose('name');
  await choose('guest');
  assert.equal((await geometry()).animations, 0, 'Reduced motion has no movement or blur animation');
  yield { name: 'reduced-motion-event', selector: root, inspect: [shell, content] };
  await capture.click(trigger);
  assert.equal((await geometry()).animations, 0);
  assert.equal((await geometry()).activeInside, true);
  await capture.click(`${root} [data-island-state="back"]`);
  assert.equal(await capture.evaluate(() => !!document.querySelector('ex-title-island-demo [role="dialog"]')), false);
  await capture.viewport(640, 900);
  await choose('guest');
  const narrow = await geometry();
  assert.ok(narrow.width <= 608, 'The island is bounded by the viewport');
  yield { name: 'narrow-event', selector: root, inspect: [shell] };

  // Verify the shell's actual title-bar composition, too.
  // Reduced-motion island checks are complete before exercising route motion.
  await capture.reducedMotion(false);
  await capture.click('a[href="/"]');
  await capture.waitFor(() => document.querySelector('ex-workspace-demo ex-title-island'));
  await capture.viewport(1240, 1000);
  await capture.click('ex-workspace-demo ex-title-island .trigger');
  await capture.waitFor(() => document.querySelector('ex-workspace-demo ex-title-island ex-machine-panel'));
  await capture.motion.finish();
  yield { name: 'workspace-open-island', inspect: ['ex-workspace-demo ex-title-island', '[role="dialog"]'] };
  await capture.press('Escape');
  await capture.waitFor(() => !document.querySelector('ex-workspace-demo ex-title-island [role="dialog"]'));
}
