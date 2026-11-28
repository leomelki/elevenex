import assert from 'node:assert/strict';

/** Exercise the connected owner, including activity outside the 20-root history page. */
export default async function* (capture) {
  await capture.waitFor(() => document.readyState === 'complete');
  await capture.evaluate(() => { if (location.pathname !== '/connected-workspace') location.href = '/connected-workspace'; });
  await capture.waitFor(() => document.querySelector('ex-workspace-navigation ex-task-list'));
  await capture.cdp('Emulation.setFocusEmulationEnabled', { enabled: true });
  const task = '[data-task-id="11"]';
  const inspect = [task, `${task} .earlier`, `${task} [data-status="review"]`];
  const session = id => `${task} [data-session-id="${id}"]`;
  const owner = (fn, data) => capture.component('ex-machine-workspace', fn, data);
  const visible = () => capture.evaluate(selector => [...document.querySelectorAll(selector + ' .row[data-session-id]')]
    .filter(row => !row.closest('[inert]')).map(row => Number(row.dataset.sessionId)), task);
  const settled = () => capture.waitFor(selector => document.querySelector(selector) &&
    document.querySelector(selector).getAnimations({ subtree: true }).every(a => !Number.isFinite(a.effect?.getComputedTiming().endTime) || a.playState !== 'running'), task);
  for (const [theme, width, reduced] of [['light', 1440, false], ['dark', 980, true]]) {
    await capture.theme(theme);
    await capture.viewport(width, 900);
    await capture.reducedMotion(reduced);
    const setUp = async overflow => {
      await capture.component('ex-connected-workspace-demo', (c, flag) => c.fixture.priorityScene(flag), overflow);
      await owner(async c => { await c.store.selectProject('2'); await c.store.selectProject('1'); });
      await settled();
    };
    await setUp(false);
    assert.deepEqual(await visible(), [200, 203, 201, 202, 233, 234]);
    assert.equal(await capture.evaluate(selector => document.querySelector(selector)?.getAttribute('aria-label'),
      `${session(203)} [data-status="review"]`), 'New reply');
    yield { name: `${theme}-priority-fills-five-root-slots`, inspect };

    await capture.evaluate(selector => document.querySelector(selector)?.focus(), `${session(203)} button.select`);
    await capture.press('Enter');
    await capture.waitFor(selector => document.querySelector(selector), `${session(203)} [data-status="done"]`);
    await settled();
    await capture.evaluate(selector => document.querySelector(selector)?.focus(), `${session(234)} button.select`);
    await capture.press('Enter');
    await capture.waitFor(selector => [...document.querySelectorAll(selector)].every(row => row.closest('[inert]')), session(203));
    await settled();
    assert.deepEqual(await visible(), [201, 202, 232, 233, 234]);
    yield { name: `${theme}-viewed-reply-releases-slot`, inspect };

    await setUp(true);
    assert.deepEqual(await visible(), [200, 203, 201, 202, 204, 205, 206, 207]);
    yield { name: `${theme}-priority-overflow`, inspect };
    const older = `${task} .earlier-more`;
    const olderLabel = () => capture.evaluate(selector => document.querySelector(selector)?.getAttribute('aria-label'), older);
    for (let batch = 0; batch < 8 && await olderLabel() !== 'Load older sessions'; batch++) {
      await capture.evaluate(selector => document.querySelector(selector)?.focus(), older);
      await capture.press('Enter');
      await settled();
    }
    assert.equal(await olderLabel(), 'Load older sessions');
    await capture.evaluate(selector => document.querySelector(selector)?.focus(), older);
    await capture.press('Enter');
    const firstNewOrdinary = theme === 'light' ? 210 : 208;
    await capture.waitFor(selector => {
      const row = document.querySelector(selector);
      return !!row && !row.closest('[inert]');
    }, session(firstNewOrdinary));
    await settled();
    assert.deepEqual(await visible(), [200, 203, 201, 202, 204, 205, 206, 207,
      ...Array.from({ length: 235 - firstNewOrdinary }, (_, index) => firstNewOrdinary + index)]);
    assert.equal(await capture.evaluate(selector => [...document.querySelectorAll(selector + ' button')]
      .some(button => button.textContent.trim() === 'Earlier sessions'), task), false);
    yield { name: `${theme}-older-extends-history-in-place`, inspect };

    await capture.evaluate(selector => document.querySelector(selector)?.focus(), `${task} .earlier-fewer`);
    await capture.press('Enter');
    await settled();
    assert.deepEqual(await visible(), [200, 203, 201, 202, 204, 205, 206, 207]);
    yield { name: `${theme}-show-fewer-keeps-priority`, inspect };
  }
}
