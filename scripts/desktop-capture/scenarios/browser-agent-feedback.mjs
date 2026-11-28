import assert from 'node:assert/strict';

/** Supplied-data preview of the real BrowserView. Live host feedback is covered
 * separately by native Electron and Chromium integration regressions. */
export default async function* browserAgentFeedback(capture) {
  await capture.waitFor(() => document.querySelector('ex-browser-demo .pay'));
  const owner = (fn, data) => capture.component('ex-browser-demo', fn, data);
  const position = () => capture.evaluate(() => {
    const cursor = document.querySelector('.agent-cursor');
    if (!cursor) return null;
    const matrix = new window.DOMMatrix(getComputedStyle(cursor).transform);
    return { x: matrix.e, y: matrix.f };
  });
  // Sample only live pointer animations. Global CDP seeking can resurrect an
  // earlier completed transition on the same property and obscure its successor.
  const seekPointer = async time => {
    await capture.evaluate(time => {
      for (const node of document.querySelectorAll('.agent-cursor, .cursor-pulse'))
        for (const animation of node.getAnimations())
          if (animation.transitionProperty === 'transform' || node.classList.contains('cursor-pulse')) animation.currentTime = time;
    }, time);
    await capture.settle();
  };
  for (const theme of ['light', 'dark']) {
    await capture.theme(theme); await capture.viewport(1000, 800); await capture.reducedMotion(false);
    await owner(component => {
      component.selectDriver('agent'); component.cursor.set({ x: 32, y: 90, pulse: 0 });
      component.step.set({ n: 1, total: 3, text: 'Reviewing the checkout', status: 'running' });
    });
    await capture.motion.finish();
    await capture.waitFor(() => {
      const root = document.querySelector('ex-browser-demo');
      const cursor = root.querySelector('.agent-cursor'), ring = root.querySelector('.target'), pay = root.querySelector('.pay');
      if (!cursor || !ring || !pay) return false;
      const point = new window.DOMMatrix(getComputedStyle(cursor).transform), target = ring.getBoundingClientRect(), button = pay.getBoundingClientRect();
      return Math.abs(point.e - 32) < 1 && Math.abs(point.f - 90) < 1 && Math.abs(target.x - button.x + 4) < 1;
    });
    const target = await owner(component => component.action());
    const destination = { x: target.x + target.w / 2, y: target.y + target.h / 2, pulse: 0 };
    await capture.motion.freeze();
    await owner((component, cursor) => {
      component.cursor.set(cursor);
      component.step.set({ n: 2, total: 3, text: 'Checking the payment action', status: 'running' });
    }, destination);
    await capture.waitFor(() => document.querySelector('.agent-cursor').getAnimations().length > 0);
    for (const time of [0, 100, 280]) {
      await seekPointer(time);
      const point = await position();
      if (time === 0) assert.ok(Math.abs(point.x - 32) < 1, JSON.stringify(point));
      if (time === 100) assert.ok(point.x > 32 && point.x < destination.x + 1, JSON.stringify(point));
      if (time === 280) assert.ok(Math.abs(point.x - destination.x) < 1);
      yield { name: `${theme}-cursor-${time}ms`, selector: 'ex-browser-demo', inspect: ['.agent-cursor', '.cursor-glyph', '.cursor-arrow', '.cursor-spark', '.target', '.agent-step'], metadata: point };
    }
    // Interrupt a second glide. The next glide starts at the currently painted pose.
    await owner((component, cursor) => component.cursor.set({ ...cursor, x: 40 }), destination);
    await seekPointer(100); const interrupted = await position();
    await owner((component, cursor) => component.cursor.set({ ...cursor, x: cursor.x + 20 }), destination);
    await seekPointer(0); const retargeted = await position();
    assert.ok(Math.abs(interrupted.x - retargeted.x) < 2, JSON.stringify({ interrupted, retargeted }));
    yield { name: `${theme}-interrupted-retarget`, selector: 'ex-browser-demo' };
    await capture.motion.finish(); await capture.motion.play();
    await capture.motion.freeze();
    await owner(component => {
      component.cursor.update(cursor => ({ ...cursor, pulse: 1 }));
      component.step.update(step => ({ ...step, text: 'Waiting for the result', status: 'waiting' }));
    });
    await seekPointer(120);
    assert.equal(await capture.evaluate(() => document.querySelectorAll('.cursor-pulse').length), 1);
    const rippleAtTip = await capture.evaluate(() => {
      const cursor = document.querySelector('.agent-cursor').getBoundingClientRect();
      const pulse = document.querySelector('.cursor-pulse').getBoundingClientRect();
      return Math.abs(pulse.x + pulse.width / 2 - cursor.x) < .5 && Math.abs(pulse.y + pulse.height / 2 - cursor.y) < .5;
    });
    assert.ok(rippleAtTip, 'Click feedback stays centred on the pointer hotspot');
    yield { name: `${theme}-click-pulse-waiting`, selector: 'ex-browser-demo', inspect: ['.cursor-pulse', '.step-status'] };
    await capture.motion.finish(); await capture.motion.play();
    for (const status of ['done', 'error']) {
      await owner((component, status) => {
        component.cursor.set(undefined); component.action.set(undefined);
        component.step.set({ n: 3, total: 3, text: status === 'done' ? 'Checkout verified' : 'The request failed; no result was confirmed', status });
      }, status);
      await capture.motion.finish();
      assert.equal(await capture.evaluate(() => !!document.querySelector('.agent-cursor')), false);
      yield { name: `${theme}-${status}`, selector: 'ex-browser-demo', inspect: ['.agent-step', '.step-status'] };
    }
    await capture.viewport(440, 800); await capture.reducedMotion(true);
    await owner(component => {
      component.cursor.set({ x: 30, y: 60, pulse: 0 });
      component.step.set({ n: 2, total: 3, text: 'Checking a long result description without hiding Stop', status: 'running' });
    });
    await owner(component => component.cursor.set({ x: 160, y: 180, pulse: 2 }));
    const instant = await position(); assert.equal(instant.x, 160); assert.equal(instant.y, 180);
    const fits = await capture.evaluate(() => {
      const stop = document.querySelector('[aria-label="Block browser agent"]').getBoundingClientRect();
      return stop.left >= 0 && stop.right <= innerWidth && stop.bottom <= innerHeight;
    });
    assert.ok(fits, 'Stop remains visible in narrow layouts');
    yield { name: `${theme}-narrow-reduced-motion`, selector: 'ex-browser-demo', inspect: ['.agent-cursor', '.agent-step', '[aria-label="Block browser agent"]'] };
    await capture.click('[aria-label="Block browser agent"]'); await capture.motion.finish();
    await capture.waitFor(() => !document.querySelector('.agent-cursor'));
    assert.equal(await capture.evaluate(() => !!document.querySelector('.agent-cursor')), false);
    assert.equal(await capture.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Allow browser agent');
    yield { name: `${theme}-stopped`, selector: 'ex-browser-demo' };
  }
}
