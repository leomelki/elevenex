import assert from 'node:assert/strict';

/** Native regressions for catalog refresh, default thinking and tooltip lifetimes. */
export default async function* (capture) {
  await capture.evaluate(() => { location.href = '/agent-picker'; });
  await capture.waitFor(() => document.querySelector('ex-agent-picker-demo'));
  // Vite handles window errors before CDP reports them as uncaught exceptions.
  await capture.evaluate(() => window.addEventListener('error', event => console.error(event.message)));
  const catalog = await capture.component('ex-agent-picker-demo', c => c.harnesses());
  const finish = async () => {
    await capture.settle();
    await capture.waitFor(() => document.getAnimations().every(a => !Number.isFinite(a.effect?.getComputedTiming().endTime) || a.playState !== 'running'));
  };
  const open = async agent => {
    await capture.component('ex-agent-picker-demo', (c, agent) => c.agent.set(agent), agent);
    await capture.click('ex-agent-picker > button');
    await capture.waitFor(() => document.querySelector('.agent-settings[aria-hidden="false"]'));
    await finish();
  };
  const close = async () => {
    await capture.component('ex-agent-picker', c => c.closePicker());
    await capture.waitFor(() => !document.querySelector('.agent-settings'));
  };
  const actualThinking = () => capture.component('ex-agent-picker-demo', c => c.agent().thinking ?? null);
  const initial = { harness: 'claude', mark: 'Cl', model: 'opus' };
  const range = '[aria-label="Thinking level"]';
  for (const theme of ['light', 'dark']) {
    await capture.theme(theme); await capture.viewport(1440, 960); await capture.reducedMotion(false);
    await capture.component('ex-agent-picker-demo', (c, catalog) => {
      c.harnesses.set(catalog); c.locked.set(true); c.busy.set(false); c.disabled.set(false);
    }, catalog);
    await open(initial);
    assert.equal(await actualThinking(), null, 'Opening must not select a thinking level');
    await capture.evaluate(() => document.querySelector('[aria-label="Thinking level"]').focus());
    // Keyboard focus must remain visible even before any level is selected.
    await capture.press('Tab'); await capture.press('Tab', 8);
    await capture.waitFor(() => document.activeElement?.matches('[aria-label="Thinking level"]:focus-visible'));
    yield { name: theme + '-unset-keyboard-focus', selector: '.agent-settings', inspect: ['ex-thinking-slider', range] };
    await capture.press('Home');
    assert.equal(await actualThinking(), 'Low');
    await capture.press('ArrowRight');
    assert.equal(await actualThinking(), 'Medium', 'Subsequent keys retain native stepping');
    await capture.component('ex-agent-picker-demo', (c, agent) => c.agent.set(agent), initial);
    await capture.press('ArrowRight');
    assert.equal(await actualThinking(), 'Low', 'The first adjustment must not skip Low');
    await capture.component('ex-agent-picker-demo', (c, agent) => c.agent.set(agent), initial);
    const point = await capture.evaluate(() => {
      const box = document.querySelector('[aria-label="Thinking level"]').getBoundingClientRect();
      return { x: box.left + 7, y: box.top + box.height / 2 };
    });
    for (const type of ['mousePressed', 'mouseReleased'])
      await capture.cdp('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
    await capture.settle();
    assert.equal(await actualThinking(), 'Low', 'Clicking the initial thumb must commit Low');
    await finish();
    yield { name: theme + '-first-thinking-step', selector: '.agent-settings', inspect: ['ex-thinking-slider', range] };
    await close();

    await open({ harness: 'opencode', mark: 'Oc', model: 'claude-opus-5.5', thinking: 'low' });
    await capture.fill('.filter input', 'Kimi');
    await capture.waitFor(() => document.querySelectorAll('.model').length === 1);
    await capture.component('ex-agent-picker-demo', c => {
      c.harnesses.update(harnesses => harnesses.map(h => h.id === 'opencode' ? { ...h, models: h.models.slice(0, 8) } : h));
    });
    assert.equal(await capture.evaluate(() => document.activeElement === document.querySelector('.filter input')), true);
    assert.equal(await capture.evaluate(() => document.querySelector('.filter input').value), 'Kimi');
    assert.equal(await capture.evaluate(() => document.querySelectorAll('.model').length), 0);
    await finish();
    yield { name: theme + '-refresh-keeps-search', selector: '.agent-settings', inspect: ['.filter input', '.models'] };
    await capture.press('Escape');
    assert.equal(await capture.evaluate(() => document.activeElement === document.querySelector('.filter input')), true);
    assert.equal(await capture.evaluate(() => document.querySelector('.filter input').value), '');
    assert.equal(await capture.evaluate(() => document.querySelectorAll('.model').length), 8);
    // Space must activate the native option, including a retained short-catalog search.
    await capture.press('ArrowDown'); await capture.press('ArrowDown');
    for (const type of ['keyDown', 'keyUp'])
      await capture.cdp('Input.dispatchKeyEvent', { type, key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: type === 'keyDown' ? ' ' : '' });
    await capture.settle();
    assert.equal(await capture.component('ex-agent-picker-demo', c => c.agent().model), 'claude-sonnet-5.5');
    assert.equal(await capture.evaluate(() => document.activeElement?.matches('.model[aria-selected="true"]')), true);
    assert.equal(await capture.evaluate(() => document.querySelector('.filter input').value), '');
    await capture.press('k');
    assert.equal(await capture.evaluate(() => document.activeElement === document.querySelector('.filter input')), true);
    await capture.press('Escape');
    await finish();
    yield { name: theme + '-cleared-search-space-selects', selector: '.agent-settings', inspect: ['.filter input', '.models'] };
    await close();
    await open({ harness: 'opencode', mark: 'Oc', model: 'claude-sonnet-5.5', thinking: 'low' });
    assert.equal(await capture.evaluate(() => !!document.querySelector('.filter input')), false, 'Search resets on a new menu');
    await close();

    await capture.component('ex-agent-picker-demo', c => c.locked.set(false));
    await open(initial);
    await capture.evaluate(() => document.querySelector('.rail [aria-label="Claude Code"]').focus());
    await capture.waitFor(() => document.querySelector('ex-tooltip'));
    // Observe the public DOM boundary, not the directive's private frame handle.
    const cleanup = await capture.evaluate(async () => {
      const anchor = document.querySelector('.rail [aria-label="Claude Code"]');
      const readRect = anchor.getBoundingClientRect;
      let reads = 0;
      anchor.getBoundingClientRect = function () { reads++; return readRect.call(this); };
      try {
        document.dispatchEvent(new window.Event('scroll'));
        const atDetach = reads;
        for (let frame = 0; frame < 4; frame++) await new Promise(requestAnimationFrame);
        return { atDetach, afterFrames: reads, tooltip: !!document.querySelector('ex-tooltip'), described: anchor.hasAttribute('aria-describedby') };
      } finally {
        anchor.getBoundingClientRect = readRect;
      }
    });
    assert.equal(cleanup.tooltip, false); assert.equal(cleanup.described, false);
    assert.equal(cleanup.afterFrames, cleanup.atDetach, 'Detached tooltip must stop polling layout');
    yield { name: theme + '-scroll-cleans-tooltip', selector: '.agent-settings', metadata: { cleanup } };
    // Switching harness also resets retained search state.
    await capture.click('.rail [aria-label="OpenCode"]');
    assert.equal(await capture.evaluate(() => !!document.querySelector('.filter input')), false);
    await capture.component('ex-agent-picker-demo', (c, catalog) => c.harnesses.set(catalog), catalog);
    await capture.fill('.filter input', 'Kimi');
    await capture.click('.rail [aria-label="Claude Code"]');
    assert.equal(await capture.evaluate(() => !!document.querySelector('.filter input')), false);
    await capture.viewport(360, 760); await capture.reducedMotion(true); await finish();
    yield { name: theme + '-narrow-reduced', inspect: ['.agent-settings', 'ex-thinking-slider'] };
    await close();
  }
}
