import assert from 'node:assert/strict';

/** Production composer and connected owner; all provider data stays in preview. */
export default async function* (capture) {
  await capture.evaluate(() => { location.href = '/connected-workspace'; });
  await capture.waitFor(() => document.querySelector('ex-machine-workspace ex-task-list'));
  await capture.component('ex-machine-workspace', c => c.store.selectSession({ taskId: '11', sessionId: '101' }));
  const mode = value => capture.component('ex-connected-workspace-demo', (c, value) => c.fixture.chat.scenario(value), value);
  const finish = async () => {
    await capture.settle();
    await capture.waitFor(() => document.getAnimations().every(a => !Number.isFinite(a.effect?.getComputedTiming().endTime) || a.playState !== 'running'));
  };
  const assertRow = async () => assert.equal(await capture.evaluate(() => {
    const bar = document.querySelector('ex-composer .bar');
    return bar.scrollWidth <= bar.clientWidth + 1;
  }), true, 'Composer toolbar must fit on one row');
  for (const theme of ['light', 'dark']) {
    await capture.viewport(1440, 960); await capture.theme(theme); await mode('ready');
    await capture.waitFor(() => document.querySelector('ex-composer .input-height') && document.querySelector('ex-agent-picker > button')?.disabled === false);
    await capture.fill('ex-composer textarea', 'Trace the retry path, then verify concurrent requests.');
    await finish(); await assertRow();
    yield { name: theme + '-composer', inspect: ['ex-composer', 'ex-composer .bar', 'ex-composer textarea'] };
    // Keyboard access, nested menu dismissal and retained textarea focus.
    await capture.press('j', 4);
    await capture.waitFor(() => document.querySelector('.agent-settings'));
    await capture.click('.agent-settings button[aria-label^="Thinking level:"]');
    await capture.waitFor(() => document.querySelector('ex-dropdown-menu[aria-label="Thinking level"]'));
    assert.equal(await capture.evaluate(() => [...document.querySelectorAll('ex-dropdown-menu[aria-label="Thinking level"] button')].find(b => b.textContent.trim() === 'Max')?.getAttribute('aria-disabled')), 'true');
    await capture.press('Home'); await capture.press('ArrowDown'); await capture.press('Enter');
    await capture.waitFor(() => document.querySelector('ex-agent-picker > button .sub')?.textContent === 'Low');
    assert.equal(await capture.evaluate(() => !!document.querySelector('.agent-settings')), true);
    await capture.click('.agent-settings button[aria-label="Fast mode"]');
    await capture.waitFor(() => document.querySelector('ex-agent-picker ex-icon[name="bolt"]'));
    await finish();
    yield { name: theme + '-agent-settings', inspect: ['.agent-settings', 'ex-agent-picker'] };
    await capture.click('.agent-settings button[aria-label^="Model:"]');
    await capture.press('Escape');
    assert.equal(await capture.evaluate(() => !!document.querySelector('.agent-settings')), true);
    await capture.press('Escape');
    await capture.waitFor(() => !document.querySelector('.agent-settings'));
    assert.equal(await capture.evaluate(() => document.activeElement?.tagName), 'TEXTAREA');
    assert.equal(await capture.evaluate(() => document.querySelector('ex-composer textarea').value), 'Trace the retry path, then verify concurrent requests.');
    await capture.press('Tab', 8);
    await capture.waitFor(() => document.querySelector('ex-mode-toggle [aria-label="Plan"]')?.getAttribute('aria-checked') === 'true');
    await finish();
    assert.equal(await capture.evaluate(() => !!document.querySelector('ex-permission-picker > button')?.checkVisibility()), false);
    yield { name: theme + '-plan', inspect: ['ex-composer', 'ex-mode-toggle'] };
    await capture.press('Tab', 8);
    await capture.waitFor(() => document.querySelector('ex-mode-toggle [aria-label="Code"]')?.getAttribute('aria-checked') === 'true');
    await capture.click('ex-permission-picker > button');
    await capture.waitFor(() => document.querySelector('[aria-label="Agent permissions"]'));
    await finish();
    yield { name: theme + '-permissions', inspect: ['[aria-label="Agent permissions"]'] };
    await capture.click('[aria-label="Agent permissions"] .choice:last-child');
    await capture.waitFor(() => document.querySelector('ex-permission-picker')?.textContent.includes('Auto-edit'));
    await capture.click('ex-composer textarea');
    await capture.press('Enter', 8);
    assert.equal(await capture.evaluate(() => document.querySelector('ex-composer textarea').value.endsWith('\n')), true);
    await capture.fill('ex-composer textarea', '');
    assert.equal(await capture.evaluate(() => document.querySelector('ex-composer button.send').disabled), true);
    await mode('running');
    await capture.waitFor(() => document.querySelector('ex-composer button.send')?.textContent.includes('Queue'));
    await capture.fill('ex-composer textarea', 'Also verify delayed retries'); await capture.press('Enter');
    await capture.waitFor(() => document.querySelectorAll('ex-composer-queue .item').length === 1);
    await capture.waitFor(() => document.querySelector('ex-composer-queue button[aria-label="Remove queued message"]')?.disabled === false);
    // Continue typing into the focused input while the queue grows.
    await capture.cdp('Input.insertText', { text: 'Then explain the change' }); await capture.press('Enter');
    await capture.waitFor(() => document.querySelectorAll('ex-composer-queue .item').length === 2);
    await capture.waitFor(() => document.querySelector('ex-composer-queue button[aria-label="Remove queued message"]')?.disabled === false);
    await finish();
    yield { name: theme + '-queued', inspect: ['ex-composer', 'ex-composer-queue'] };
    await capture.evaluate(() => document.querySelector('ex-composer-queue .item')?.focus());
    // Use trusted pointer hover before activating the normally quiet row actions.
    await capture.hover('ex-composer-queue .item:first-child');
    await capture.click('ex-composer-queue .item:first-child button[aria-label="Remove queued message"]');
    await capture.waitFor(() => document.querySelectorAll('ex-composer-queue .item').length === 1);
    assert.equal(await capture.evaluate(() => document.activeElement?.tagName), 'TEXTAREA');
    await capture.cdp('Input.insertText', { text: 'Keep the current provider' }); await capture.press('Enter', 1);
    await capture.waitFor(() => document.querySelector('ex-composer textarea').value === '');
    await capture.waitFor(() => document.querySelector('ex-session-chat .status')?.textContent.includes('Ready'));
    await capture.fill('ex-composer textarea', 'A longer draft\nwith a second line\nand one more line for context.');
    await capture.viewport(760, 760); await capture.reducedMotion(true); await finish(); await assertRow();
    yield { name: theme + '-narrow-reduced', inspect: ['ex-composer', 'ex-composer .bar', 'ex-mode-toggle', 'ex-agent-picker', 'ex-permission-picker'] };
    await capture.click('ex-agent-picker > button'); await finish();
    yield { name: theme + '-narrow-settings', inspect: ['.agent-settings', '.field'] };
    await capture.press('Escape'); await capture.reducedMotion(false);
    await mode('running');
    await capture.click('ex-composer textarea'); await capture.press('.', 4);
    await capture.waitFor(() => document.querySelector('ex-session-chat .status')?.textContent.includes('Ready'));
    assert.equal(await capture.evaluate(() => document.querySelector('ex-composer textarea').value.startsWith('A longer draft')), true);
  }
  await capture.viewport(1440, 960); await mode('ready');
  await capture.fill('ex-composer textarea', 'A short draft'); await finish();
  await capture.fill('ex-composer textarea', 'A growing draft\nwith several lines\nthat stays editable\nwhile its height eases.');
  const growth = await capture.measureMotion(['ex-composer', 'ex-composer textarea'], 100);
  // Replace text while height is still easing; keep native text input focused.
  await capture.evaluate(() => document.querySelector('ex-composer textarea').select());
  await capture.cdp('Input.insertText', { text: 'Interrupt the resize with a short draft' });
  const interrupted = await capture.measureMotion(['ex-composer', 'ex-composer textarea'], 300);
  assert.equal(await capture.evaluate(() => document.querySelector('ex-composer textarea').value), 'Interrupt the resize with a short draft');
  yield { name: 'interrupted-draft-growth', inspect: ['ex-composer', 'ex-composer textarea'], metadata: { growth, interrupted } };
  // Unknown delivery is retained and never implicitly resubmitted.
  await capture.viewport(1440, 960); await mode('unknown');
  await capture.fill('ex-composer textarea', 'Retain this message if delivery is uncertain'); await capture.press('Enter');
  await capture.waitFor(() => document.querySelector('ex-session-chat .feedback.error'));
  await capture.waitFor(() => document.querySelector('ex-composer textarea').value === 'Retain this message if delivery is uncertain');
  await finish();
  assert.equal(await capture.evaluate(() => document.querySelector('ex-composer .send').disabled), true);
  yield { name: 'uncertain-composer', inspect: ['ex-composer', 'ex-session-chat .feedback'] };
}
