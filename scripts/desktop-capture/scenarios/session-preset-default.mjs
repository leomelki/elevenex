import assert from 'node:assert/strict';

export default async function* (capture) {
  await capture.evaluate(() => { location.href = '/connected-workspace'; });
  await capture.waitFor(() => !!document.querySelector('ex-workspace-navigation ex-task-list'));
  const select = id => capture.component('ex-machine-workspace', (c, id) => c.store.selectSession({ taskId: '11', sessionId: id }), id);
  await select('102');
  const settle = async () => { await capture.settle(); await capture.waitFor(() => document.getAnimations().every(a => a.effect?.target?.closest?.('ex-toast') || !Number.isFinite(a.effect?.getComputedTiming().endTime) || a.playState !== 'running')); };
  const chooseQuick = async () => {
    const index = await capture.evaluate(() => [...document.querySelectorAll('[role="menuitemradio"]')].findIndex(item => item.textContent.includes('Quick pass')));
    await capture.press('Home');
    for (let step = 0; step < index; step++) await capture.press('ArrowDown');
    await capture.press('Enter');
  };
  for (const theme of ['light', 'dark']) {
    await capture.theme(theme); await capture.viewport(1440, 960);
    await capture.waitFor(() => !!document.querySelector('.default-preset button:not(:disabled)'));
    await capture.fill('ex-composer textarea', 'Review the checkout flow and keep the changes focused.');
    await settle(); yield { name: theme + '-default-label', inspect: ['.preset-heading', 'ex-preset-picker'] };
    await capture.click('.default-preset button'); await capture.waitFor(() => !!document.querySelector('[role="menu"]'));
    await settle(); yield { name: theme + '-default-menu', inspect: ['[role="menu"]', '.preset-heading'] };
    await chooseQuick();
    await capture.waitFor(() => document.querySelector('.default-preset button')?.textContent.includes('Quick pass'));
    await capture.waitFor(() => document.querySelector('.preset-toast')?.textContent.includes('Quick pass'));
    assert.equal(await capture.evaluate(() => document.querySelector('ex-composer textarea').value), 'Review the checkout flow and keep the changes focused.');
    assert.equal(await capture.evaluate(() => document.querySelector('ex-preset-picker .default')?.closest('button').textContent.includes('Quick pass')), true);
    await settle(); yield { name: theme + '-changed-default', inspect: ['.preset-heading', 'ex-preset-picker', '.preset-toast'] };
    await capture.click('.preset-toast button[data-variant="ghost"]');
    await capture.waitFor(() => document.querySelector('.default-preset button')?.textContent.includes('Deep work'));
    assert.equal(await capture.evaluate(() => document.querySelector('ex-preset-picker button[aria-pressed="true"]')?.textContent.includes('Quick pass')), true);
    await settle(); yield { name: theme + '-undo', inspect: ['.preset-heading', 'ex-preset-picker'] };
    await capture.click('.preset-heading > button'); await capture.waitFor(() => !!document.querySelector('.preset-creator'));
    const name = theme === 'light' ? 'Focused review' : 'Ship carefully';
    await capture.fill('.preset-creator input:not([type="checkbox"])', name);
    const keep = '.default-choice button[aria-label="Keep current"]';
    await capture.click(keep);
    assert.equal(await capture.evaluate(() => document.querySelector('.default-choice button[aria-label="Keep current"]').getAttribute('aria-checked')), 'true');
    await settle(); yield { name: theme + '-creator-keep-default', inspect: ['.preset-creator', '.default-choice'] };
    await capture.press('ArrowRight');
    await capture.waitFor(() => document.querySelector('.default-choice button[aria-label="Use this preset"]')?.getAttribute('aria-checked') === 'true');
    assert.equal(await capture.evaluate(() => document.querySelector('.preset-creator ex-preset-card')), null);
    await settle(); yield { name: theme + '-creator-default', inspect: ['.preset-creator'] };
    await capture.viewport(1000, 760); await capture.reducedMotion(true); await settle();
    yield { name: theme + '-narrow-creator', inspect: ['.preset-creator'] };
    await capture.viewport(420, 780); await settle();
    yield { name: theme + '-compact-creator', inspect: ['.preset-creator', '.default-choice'] };
    await capture.viewport(1000, 760);
    await capture.click('.preset-creator button[type="submit"]'); await capture.waitFor(() => !document.querySelector('.preset-creator'));
    await capture.waitFor(name => document.querySelector('.default-preset button')?.textContent.includes(name), name);
    await settle(); yield { name: theme + '-created-default', inspect: ['.preset-heading', 'ex-preset-picker', '.preset-toast'] };
    // Undo creation's default setting keeps the saved preset and current selection.
    await capture.click('.preset-toast button[data-variant="ghost"]');
    await capture.waitFor(() => document.querySelector('.default-preset button')?.textContent.includes('Deep work'));
    assert.equal(await capture.evaluate(name => document.querySelector('ex-preset-picker').textContent.includes(name), name), true);
    await capture.reducedMotion(false);
  }
  // A new conversation receives the saved default from the preview backend.
  await capture.click('.default-preset button'); await chooseQuick();
  await capture.waitFor(() => document.querySelector('.default-preset button')?.textContent.includes('Quick pass'));
  await capture.component('ex-machine-workspace', c => c.store.createSession('11'));
  await capture.waitFor(() => document.querySelector('ex-session-chat textarea')?.value === '' && document.querySelector('ex-preset-picker button[aria-pressed="true"]')?.textContent.includes('Quick pass'));
  await settle(); yield { name: 'new-chat-default', inspect: ['ex-preset-picker', 'ex-composer'] };
  for (const theme of ['light', 'dark']) {
    await capture.theme(theme); await capture.viewport(1440, 960);
    await capture.component('ex-connected-workspace-demo', c => c.fixture.chat.presetCatalog('empty'));
    await capture.waitFor(() => document.querySelectorAll('ex-preset-card').length === 1);
    await capture.fill('ex-composer textarea', 'Keep my draft while choosing the first default.');
    await capture.click('ex-preset-picker button.custom');
    await capture.waitFor(() => document.querySelector('.default-choice button[aria-label="Use this preset"]')?.getAttribute('aria-checked') === 'true');
    await settle(); yield { name: theme + '-no-default-selected', inspect: ['.preset-creator', '.default-choice'] };
    await capture.click('.default-choice button[aria-label="Keep current"]');
    await capture.press('Escape'); await capture.waitFor(() => !document.querySelector('.preset-creator'));
    assert.equal(await capture.evaluate(() => document.querySelector('ex-composer textarea').value), 'Keep my draft while choosing the first default.');
    assert.equal(await capture.evaluate(() => !!document.querySelector('.default-preset')), false);
    await capture.click('.preset-heading > button');
    await capture.waitFor(() => document.querySelector('.default-choice button[aria-label="Use this preset"]')?.getAttribute('aria-checked') === 'true');
    const name = 'First ' + theme + ' preset';
    await capture.fill('.preset-creator input', name);
    await capture.viewport(420, 780); await capture.reducedMotion(true); await settle();
    yield { name: theme + '-no-default-compact', inspect: ['.preset-creator', '.default-choice'] };
    await capture.click('.preset-creator button[type="submit"]'); await capture.waitFor(() => !document.querySelector('.preset-creator'));
    await capture.viewport(1440, 960);
    await capture.waitFor(name => document.querySelector('.default-preset button')?.textContent.includes(name), name);
    await capture.component('ex-machine-workspace', c => c.store.createSession('11'));
    await capture.waitFor(name => document.querySelector('ex-session-chat textarea')?.value === '' && document.querySelector('ex-preset-picker button[aria-pressed="true"]')?.textContent.includes(name), name);
    await settle(); yield { name: theme + '-first-default-applied', inspect: ['.preset-heading', 'ex-preset-picker', 'ex-composer'] };
    await capture.reducedMotion(false);
  }
}
