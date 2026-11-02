import assert from 'node:assert/strict';

export default async function* (capture) {
  await capture.evaluate(() => { location.href = '/connected-workspace'; });
  await capture.waitFor(() => !!document.querySelector('ex-workspace-navigation ex-task-list'));
  await capture.component('ex-machine-workspace', c => c.store.selectSession({ taskId: '11', sessionId: '102' }));
  const opener = 'ex-session-chat .preset-heading > button';
  const catalog = mode => capture.component('ex-connected-workspace-demo', (c, mode) => c.fixture.chat.presetCatalog(mode), mode);
  const settle = async () => {
    await capture.settle();
    await capture.waitFor(() => document.getAnimations().every(a => !Number.isFinite(a.effect?.getComputedTiming().endTime) || a.playState !== 'running'));
  };
  for (const theme of ['light', 'dark']) {
    await capture.theme(theme); await capture.viewport(1440, 960);
    await catalog('empty');
    await capture.waitFor(() => document.querySelectorAll('ex-preset-card').length === 1);
    await capture.fill('ex-composer textarea', 'Keep my draft while creating a preset.');
    await settle();
    const empty = await capture.evaluate(() => {
      const card = document.querySelector('ex-preset-card button');
      return { width: card.getBoundingClientRect().width, border: getComputedStyle(card).borderStyle,
        defaultPicker: !!document.querySelector('.default-preset'), pressed: card.getAttribute('aria-pressed') };
    });
    assert.ok(empty.width <= 190, `A single card must retain the designed grid width: ${empty.width}`);
    assert.equal(empty.border, 'none'); assert.equal(empty.defaultPicker, false); assert.equal(empty.pressed, 'true');
    yield { name: theme + '-empty-catalog', inspect: ['.start', 'ex-preset-picker', 'ex-composer'] };
    const selectedShadow = await capture.evaluate(() => getComputedStyle(document.querySelector('ex-preset-card button')).boxShadow);
    await capture.hover('ex-preset-card button'); await settle();
    assert.equal(await capture.evaluate(() => getComputedStyle(document.querySelector('ex-preset-card button')).boxShadow), selectedShadow);
    await capture.evaluate(() => document.querySelector('.preset-heading > button').focus());
    await capture.press('Tab');
    assert.equal(await capture.evaluate(() => document.activeElement === document.querySelector('ex-preset-card button')), true);
    assert.equal(await capture.evaluate(() => getComputedStyle(document.activeElement).outlineStyle), 'solid');
    yield { name: theme + '-custom-focus', inspect: ['ex-preset-card button'] };

    await capture.motion.freeze(); await capture.click(opener);
    for (const time of [0, 140, 280]) {
      await capture.evaluate(time => {
        for (const animation of document.getAnimations()) {
          if (animation.effect?.target?.closest?.('.ex-modal-layer, [data-modal-background]') && Number.isFinite(animation.effect.getComputedTiming().endTime)) animation.currentTime = time;
        }
      }, time);
      await capture.settle();
      const motion = await capture.evaluate(() => {
        const layer = document.querySelector('.ex-modal-layer'), surface = document.querySelector('.preset-creator'), dim = layer.querySelector('.ex-modal-dim');
        return { layerOpacity: getComputedStyle(layer).opacity, surfaceOpacity: Number(getComputedStyle(surface).opacity),
          background: getComputedStyle(surface).backgroundColor,
          dimOpacity: Number(getComputedStyle(dim).opacity), dimBackground: getComputedStyle(dim).backgroundColor,
          durations: document.getAnimations().filter(a => a.effect?.target?.closest?.('.ex-modal-layer')).map(a => a.effect.getTiming().duration) };
      });
      assert.equal(motion.layerOpacity, '1');
      assert.notEqual(motion.background, 'rgba(0, 0, 0, 0)');
      assert.notEqual(motion.dimBackground, 'rgba(0, 0, 0, 0)');
      assert.ok(motion.durations.every(duration => duration <= 280));
      if (time > 0) assert.ok(motion.dimOpacity > 0);
      if (time === 280) { assert.equal(motion.surfaceOpacity, 1); assert.equal(motion.dimOpacity, 1); }
      yield { name: theme + '-opening-' + time, inspect: ['.preset-creator', '.ex-modal-layer', '.ex-modal-dim'], metadata: { motion } };
    }
    await capture.motion.finish(); await capture.motion.play();
    await capture.waitFor(() => document.activeElement?.matches('.preset-creator input'));
    await capture.fill('.preset-creator input', 'Focused review');
    await capture.press('Tab', 8);
    assert.equal(await capture.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Close preset creator');
    await capture.press('Tab', 8);
    assert.equal(await capture.evaluate(() => document.activeElement === document.querySelector('.preset-creator button[type="submit"]')), true);
    await capture.press('Tab');
    assert.equal(await capture.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Close preset creator');
    await settle(); yield { name: theme + '-creator-focus', inspect: ['.preset-creator'] };

    // Escape during entry retains an inert exit; reopening gets a fresh draft.
    await capture.press('Escape'); await capture.waitFor(() => !document.querySelector('.preset-creator'));
    assert.equal(await capture.evaluate(() => document.activeElement === document.querySelector('.preset-heading > button')), true);
    await capture.motion.freeze(); await capture.click(opener);
    await capture.evaluate(() => {
      for (const animation of document.getAnimations()) if (animation.effect?.target?.closest?.('.ex-modal-layer')) animation.currentTime = 70;
    });
    await capture.press('Escape');
    assert.equal(await capture.evaluate(() => document.querySelector('.ex-modal-layer')?.hasAttribute('inert')), true);
    await capture.motion.finish(); await capture.motion.play();
    await capture.waitFor(() => !document.querySelector('.preset-creator'));
    assert.equal(await capture.evaluate(() => document.activeElement === document.querySelector('.preset-heading > button')), true);

    await catalog('saved'); await capture.waitFor(() => document.querySelectorAll('ex-preset-card').length === 4);
    await capture.evaluate(() => document.querySelector('.preset-heading > button').focus());
    for (let index = 0; index < 4; index++) await capture.press('Tab');
    assert.equal(await capture.evaluate(() => document.activeElement?.matches('ex-preset-card button.custom:not(.selected)')), true);
    assert.equal(await capture.evaluate(() => getComputedStyle(document.activeElement).outlineStyle), 'solid');
    yield { name: theme + '-custom-choice-focus', inspect: ['ex-preset-card button.custom'] };
    await capture.click(opener); await settle();
    await capture.fill('.preset-creator input', 'Deep work'); await settle();
    assert.equal(await capture.evaluate(() => document.querySelector('.preset-creator button[type="submit"]').disabled), true);
    yield { name: theme + '-validation', inspect: ['.preset-creator'] };
    await capture.reducedMotion(true); await capture.viewport(420, 360); await settle();
    const compact = await capture.evaluate(() => {
      const surface = document.querySelector('.preset-creator'), footer = surface.querySelector('footer').getBoundingClientRect();
      return { width: surface.clientWidth, scrollWidth: surface.scrollWidth, footerTop: footer.top, footerBottom: footer.bottom,
        height: innerHeight, scrollable: surface.querySelector('.scroll').scrollHeight > surface.querySelector('.scroll').clientHeight };
    });
    assert.ok(compact.scrollWidth <= compact.width);
    assert.ok(compact.footerTop >= 0 && compact.footerBottom <= compact.height);
    assert.equal(compact.scrollable, true);
    yield { name: theme + '-short-window', inspect: ['.preset-creator', '.preset-creator footer'], metadata: { compact } };
    await capture.press('Escape'); await capture.waitFor(() => !document.querySelector('.preset-creator'));
    assert.equal(await capture.evaluate(() => document.querySelector('ex-composer textarea').value), 'Keep my draft while creating a preset.');
    await capture.viewport(1000, 760); await settle();
    yield { name: theme + '-narrow-cards', inspect: ['.start', 'ex-preset-picker'] };
    await capture.reducedMotion(false);
  }
}
