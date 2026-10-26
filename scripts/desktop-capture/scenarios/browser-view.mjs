import assert from 'node:assert/strict';

// Run against desktop:preview. Supplied page data stays outside production.
export default async function* (capture) {
  await capture.viewport(1240, 1000);
  if (!await capture.evaluate(() => !!document.querySelector('ex-browser-demo'))) {
    await capture.evaluate(() => document.querySelector('a[href="/machines"]').scrollIntoView());
    await capture.click('a[href="/machines"]');
  }
  await capture.waitFor(() => document.querySelector('ex-browser-demo'));
  await capture.evaluate(() => document.querySelector('ex-browser-demo').scrollIntoView({ block: 'center' }));
  await capture.waitFor(() => document.querySelector('ex-browser-demo .target'));
  const owner = fn => capture.component('ex-browser-demo', fn);
  const geometry = () => capture.evaluate(() => {
    const root = document.querySelector('ex-browser-demo');
    const box = selector => {
      const rect = root.querySelector(selector).getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom };
    };
    const frame = root.querySelector('.driving-frame');
    return {
      ring: box('.target'), pay: box('.pay'), preview: box('.preview'), toolbar: box('.toolbar'), driver: box('.driver'),
      bottom: box('.browser').bottom, foot: box('.agent-step'),
      dots: root.querySelectorAll('.step-dots i').length,
      currentDots: root.querySelectorAll('.step-dots .now').length,
      liveTabs: root.querySelectorAll('.agent.driving').length,
      errorsHidden: root.querySelector('.errors').closest('ex-fold').hasAttribute('inert'),
      frameAbovePage: !!frame && Number(getComputedStyle(frame).zIndex) > (Number(getComputedStyle(root.querySelector('.page')).zIndex) || 0),
      fits: ['.toolbar', '.agent-step'].every(selector => {
        const row = root.querySelector(selector), bounds = row.getBoundingClientRect();
        return Array.from(row.children).every(child => {
          const rect = child.getBoundingClientRect();
          return rect.x >= bounds.x - 1 && rect.right <= bounds.right + 1;
        });
      }),
    };
  });
  const aligned = state => {
    assert.ok(Math.abs(state.ring.x - state.pay.x + 4) < 1, 'Ring follows the button horizontally');
    assert.ok(Math.abs(state.ring.y - state.pay.y + 4) < 1, 'Ring follows the button vertically');
    assert.ok(Math.abs(state.ring.width - state.pay.width - 8) < 1);
    assert.ok(Math.abs(state.ring.height - state.pay.height - 8) < 1);
    assert.ok(state.ring.bottom < state.preview.bottom, 'The action stays visible');
    assert.equal(state.dots, 9); assert.equal(state.currentDots, 1);
    assert.equal(state.frameAbovePage, true); assert.equal(state.liveTabs, 1); assert.equal(state.errorsHidden, true); assert.equal(state.fits, true, JSON.stringify(state));
    assert.ok(state.driver.right <= state.toolbar.right);
    assert.ok(state.foot.bottom <= state.bottom + 1, 'The complete workflow bar fits the panel');
  };
  const finish = () => capture.evaluate(() => {
    for (const animation of document.getAnimations()) {
      if (Number.isFinite(animation.effect?.getComputedTiming().endTime)) animation.finish();
    }
  });
  const settled = async () => {
    await capture.settle(); await finish();
    await capture.waitFor(() => {
      const root = document.querySelector('ex-browser-demo');
      const target = root.querySelector('.target');
      if (!target) return true;
      const ring = target.getBoundingClientRect(), button = root.querySelector('.pay').getBoundingClientRect();
      return Math.abs(ring.x - button.x + 4) < 1 && Math.abs(ring.y - button.y + 4) < 1 && Math.abs(ring.width - button.width - 8) < 1;
    });
    await capture.settle();
  };
  for (const theme of ['light', 'dark']) {
    await capture.theme(theme);
    await capture.reducedMotion(false);
    await capture.evaluate(() => { document.querySelector('ex-browser-demo').style.maxWidth = ''; });
    await owner(component => { component.selectDriver('agent'); component.width.set('full'); });
    await settled();
    aligned(await geometry());
    yield { name: `${theme}-agent-drives`, selector: 'ex-browser-demo', inspect: ['.driving-frame', '.agent-cursor', '.step-dots'] };

    await capture.click('ex-browser-demo [aria-label="Phone width"]');
    await settled();
    assert.equal(await capture.evaluate(() => document.querySelector('ex-browser-demo .page').getBoundingClientRect().width), 390);
    aligned(await geometry());
    yield { name: `${theme}-phone`, selector: 'ex-browser-demo' };
    await capture.click('ex-browser-demo [aria-label="Full width"]');
    await settled();

    // Freeze a retarget in flight: both ring and cursor must glide to it.
    const action = await capture.component('ex-browser-demo', component => component.action());
    await capture.motion.freeze();
    await capture.component('ex-browser-demo', (component, action) => component.action.set({ ...action, x: action.x + 40 }), action);
    await capture.waitFor(() => document.querySelector('ex-browser-demo .target').getAnimations().length > 0);
    await capture.evaluate(() => {
      for (const selector of ['.target', '.agent-cursor']) {
        for (const animation of document.querySelector('ex-browser-demo').querySelector(selector).getAnimations()) animation.currentTime = 120;
      }
    });
    await capture.settle();
    const moving = await capture.evaluate(() => {
      const root = document.querySelector('ex-browser-demo');
      const x = selector => new window.DOMMatrix(getComputedStyle(root.querySelector(selector)).transform).e;
      return { ring: x('.target'), cursor: x('.agent-cursor') };
    });
    assert.ok(moving.ring > action.x - 4 && moving.ring < action.x + 36, 'Ring has an intermediate pose');
    assert.ok(moving.cursor > action.x + action.w * .62 && moving.cursor < action.x + action.w * .62 + 40, 'Cursor has an intermediate pose');
    yield { name: `${theme}-cursor-glides`, selector: 'ex-browser-demo', metadata: moving };
    await capture.component('ex-browser-demo', (component, action) => component.action.set(action), action);
    await finish(); await capture.motion.play();

    await capture.click('ex-browser-demo .shop-header b');
    await settled();
    assert.equal(await capture.evaluate(() => !!document.querySelector('ex-browser-demo .agent-cursor, ex-browser-demo .driving-frame, ex-browser-demo .agent.driving')), false);
    assert.equal(await capture.evaluate(() => document.querySelector('ex-browser-demo .errors').closest('ex-fold').hasAttribute('inert')), false);
    yield { name: `${theme}-you-drive`, selector: 'ex-browser-demo' };
    await capture.click('ex-browser-demo ex-fold.open .foot:has(ex-icon[name="cursor"]) button');
    await settled();
    assert.equal(await capture.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Page preview');
    aligned(await geometry());

    await capture.evaluate(() => document.querySelector('ex-browser-demo').style.maxWidth = '440px');
    await settled();
    aligned(await geometry());
    yield { name: `${theme}-panel-width`, selector: 'ex-browser-demo', inspect: ['.toolbar', '.agent-step'] };
    await capture.click('ex-browser-demo .controls button:nth-child(3)');
    await settled();
    yield { name: `${theme}-needs-you`, selector: 'ex-browser-demo' };
    await capture.click('ex-browser-demo .needs button');
    await settled();
    assert.equal(await capture.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Page preview');
    await capture.click('ex-browser-demo [aria-label="Point and ask (⇧⌘C)"]');
    await capture.waitFor(() => document.activeElement?.tagName === 'TEXTAREA');
    assert.equal(await capture.evaluate(() => !!document.querySelector('ex-browser-demo .target.picked')), true);
    yield { name: `${theme}-point-and-ask`, selector: 'ex-browser-demo' };
    await capture.press('Escape');
    await capture.waitFor(() => !document.querySelector('ex-browser-demo textarea'));
    assert.equal(await capture.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Point and ask (⇧⌘C)');
    await capture.reducedMotion(true);
    await owner(component => component.selectDriver('agent'));
    await settled();
    const animations = await capture.evaluate(() => document.querySelector('ex-browser-demo').getAnimations({ subtree: true }).filter(animation => animation.playState === 'running').length);
    assert.equal(animations, 0, 'Reduced motion stops every loop and transition');
    yield { name: `${theme}-reduced-motion`, selector: 'ex-browser-demo' };
  }
}
