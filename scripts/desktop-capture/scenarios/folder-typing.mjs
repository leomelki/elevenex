import assert from 'node:assert/strict';

/** Trusted input against production components, with bounded preview-only latency. */
export default async function* (capture) {
  await capture.evaluate(() => { if (location.pathname !== '/connected-workspace') location.href = '/connected-workspace'; });
  await capture.waitFor(() => document.querySelector('ex-workspace-navigation ex-task-list'));
  const field = '.dialog ex-folder-suggestions input';
  const fixture = (fn, value) => capture.component('ex-connected-workspace-demo', fn, value);
  const finish = async () => {
    await capture.settle();
    await capture.waitFor(() => document.getAnimations().every(animation => !Number.isFinite(animation.effect?.getComputedTiming().endTime) || animation.playState !== 'running'));
  };
  const { root } = await capture.cdp('DOM.getDocument', { depth: 0 });
  const popupNode = async () => (await capture.cdp('DOM.querySelector', { nodeId: root.nodeId, selector: '[role="listbox"]' })).nodeId;
  for (const theme of ['light', 'dark']) {
    await capture.viewport(1280, 900); await capture.theme(theme);
    await capture.click('ex-project-rail [aria-label="Add project"]');
    await capture.waitFor(() => document.querySelectorAll('[role="option"]').length === 3);
    await finish();
    const originalPopup = await popupNode();
    await fixture(component => component.fixture.setFolderDelay(1200));
    await capture.fill(field, '~/d');
    assert.equal(await capture.evaluate(() => document.querySelector('[role="listbox"]').getAttribute('aria-busy')), 'true');
    assert.equal(await capture.evaluate(() => document.querySelectorAll('[role="option"]').length), 1);
    assert.equal(await popupNode(), originalPopup, 'typing retains the actual popup');
    assert.equal(await capture.evaluate(() => !!document.querySelector('.pending-rows')), false, 'compatible rows stay usable instead of turning into skeletons');
    yield { name: `${theme}-instant-filter`, inspect: ['.dialog', '[role="listbox"]', 'ex-folder-suggestions input'] };

    await capture.evaluate(selector => { document.querySelector(selector).setSelectionRange(2, 3); }, field);
    await capture.waitFor(() => document.querySelector('[role="listbox"]').getAttribute('aria-busy') === 'false');
    assert.deepEqual(await capture.evaluate(selector => { const input = document.querySelector(selector); return [input.selectionStart, input.selectionEnd, input === document.activeElement]; }, field), [2, 3, true]);
    yield { name: `${theme}-preserved-caret`, inspect: ['.dialog', 'ex-folder-suggestions input'] };

    await capture.fill(field, '~/');
    assert.equal(await capture.evaluate(() => document.querySelectorAll('[role="option"]').length), 3, 'backtracking reuses the bounded parent window');
    await capture.press('ArrowDown'); await capture.press('ArrowDown');
    assert.equal(await capture.evaluate(() => document.querySelector('[role="option"][aria-selected="true"] .option-name').textContent.trim()), 'design');
    await capture.fill(field, '~/de');
    assert.equal(await capture.evaluate(() => document.querySelector('[role="option"][aria-selected="true"] .option-name').textContent.trim()), 'design');
    yield { name: `${theme}-preserved-selection`, inspect: ['.dialog', '[role="listbox"]'] };
    await capture.press('Tab');
    assert.equal(await capture.evaluate(selector => document.querySelector(selector).value, field), '~/design/');
    assert.equal(await capture.evaluate(() => document.querySelectorAll('[role="option"]').length), 0, 'parent rows cannot be selected while opening a different directory');
    await capture.waitFor(() => !!document.querySelector('.field-status ex-status-glyph'));
    yield { name: `${theme}-directory-loading`, inspect: ['.dialog', '[role="listbox"]', '.field-status'] };
    await capture.waitFor(() => document.querySelector('[role="option"]')?.textContent.includes('assets'));
    await finish();
    assert.deepEqual(await capture.evaluate(selector => { const input = document.querySelector(selector); return [input.value, input.selectionStart, input.selectionEnd]; }, field), ['~/design/', 9, 9]);
    yield { name: `${theme}-home-path-completion`, inspect: ['.dialog', '[role="listbox"]'] };

    await capture.press('Escape');
    await capture.waitFor(() => !document.querySelector('[role="listbox"]'));
    await capture.click(field);
    await capture.waitFor(() => document.querySelector('[role="listbox"]'));
    await fixture(component => component.fixture.setFolderDelay(0));
    await capture.fill(field, '~/design');
    await capture.press('Enter');
    await capture.waitFor(() => !!document.querySelector('.dialog [aria-label="Remove design"]'));
    await finish();
    yield { name: `${theme}-enter-adds-directory`, inspect: ['.dialog', '.repo'] };

    await capture.viewport(390, 740); await capture.reducedMotion(true);
    await capture.fill(field, '~/');
    await capture.waitFor(() => document.querySelectorAll('[role="option"]').length === 3);
    await finish();
    assert.equal(await capture.evaluate(() => document.querySelector('.drop').scrollWidth <= document.querySelector('.drop').clientWidth), true);
    yield { name: `${theme}-narrow-reduced`, inspect: ['.dialog', '.drop'] };
    await capture.click('.dialog [aria-label="Cancel new project"]'); await finish();
    await capture.reducedMotion(false);
  }
}
