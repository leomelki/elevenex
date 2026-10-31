import assert from 'node:assert/strict';

export default async function* (capture) {
  await capture.evaluate(() => { location.href = '/connected-workspace'; });
  await capture.waitFor(() => !!document.querySelector('ex-workspace-navigation ex-task-list'));
  await capture.component('ex-machine-workspace', c => c.store.selectSession({ taskId: '11', sessionId: '102' }));
  const settle = async () => { await capture.settle(); await capture.waitFor(() => document.getAnimations().every(a => a.effect?.target?.closest?.('ex-toast') || !Number.isFinite(a.effect?.getComputedTiming().endTime) || a.playState !== 'running')); };
  const behavior = (delay, fail = false) => capture.component('ex-connected-workspace-demo', (c, state) => c.fixture.chat.catalogBehavior(state.delay, state.fail), { delay, fail });
  const chooseHarness = async label => {
    await capture.click('.preset-creator button[aria-label^="Harness:"]');
    await capture.waitFor(() => !!document.querySelector('[role="menu"]'));
    const index = await capture.evaluate(label => [...document.querySelectorAll('[role="menuitemradio"]')].findIndex(b => b.textContent.includes(label)), label);
    assert.ok(index >= 0);
    await capture.press('Home'); for (let i = 0; i < index; i++) await capture.press('ArrowDown');
    await capture.press('Enter');
  };
  const codexOutside = async () => assert.equal(await capture.evaluate(() => document.querySelector('ex-session-chat .provider').textContent.trim()), 'Codex');
  for (const theme of ['light', 'dark']) {
    await capture.theme(theme); await capture.viewport(1440, 960);
    await capture.waitFor(() => !!document.querySelector('ex-session-chat .preset-heading > button:not(:disabled)'));
    const deepIndex = await capture.evaluate(() => [...document.querySelectorAll('ex-preset-picker ex-preset-card')].findIndex(card => card.textContent.includes('Deep work')));
    await capture.click(`ex-preset-picker ex-preset-card:nth-child(${deepIndex + 1}) button`);
    await capture.waitFor(() => document.querySelector('ex-session-chat .provider')?.textContent.trim() === 'Codex');
    await capture.fill('ex-composer textarea', 'Keep this message while I choose the harness.');
    await capture.evaluate(() => document.querySelector('ex-session-chat .preset-heading > button').scrollIntoView({ block: 'center' }));
    await capture.settle();
    await capture.click('ex-session-chat .preset-heading > button'); await capture.waitFor(() => !!document.querySelector('.preset-creator'));
    await capture.fill('.preset-creator input', 'Cross-harness review');
    await capture.click('.preset-creator button[aria-label^="Harness:"]'); await settle();
    yield { name: theme + '-harness-menu', inspect: ['.preset-creator', '[role="menu"]'] };
    await capture.press('Escape');
    await behavior(1500); await chooseHarness('Claude Code');
    await capture.waitFor(() => !!document.querySelector('.catalog-status'));
    await codexOutside();
    assert.equal(await capture.evaluate(() => document.querySelector('.preset-creator button[type="submit"]').disabled), true);
    yield { name: theme + '-loading', inspect: ['.preset-creator', '.catalog-status'] };
    // Changing the harness during a slow read cancels it and restores the local Codex mix.
    await chooseHarness('Codex'); await capture.waitFor(() => !document.querySelector('.catalog-status'));
    assert.equal(await capture.evaluate(() => document.querySelector('.preset-creator input').value), 'Cross-harness review');
    await behavior(0, true); await chooseHarness('Claude Code');
    await capture.waitFor(() => !!document.querySelector('.catalog-error'));
    await settle(); yield { name: theme + '-retry', inspect: ['.preset-creator', '.catalog-error'] };
    await behavior(0); await capture.click('.catalog-error button');
    await capture.waitFor(() => document.querySelector('.preset-creator button[aria-label^="Model:"]')?.textContent.includes('Sonnet'));
    await capture.click('.preset-creator [aria-label="Thinking level"] button[aria-label="Low"]');
    await chooseHarness('Codex'); await chooseHarness('Claude Code');
    assert.equal(await capture.evaluate(() => document.querySelector('.preset-creator [aria-label="Thinking level"] button[aria-checked="true"]').getAttribute('aria-label')), 'Low');
    await codexOutside(); await settle();
    yield { name: theme + '-claude-draft', inspect: ['.preset-creator'] };
    await capture.viewport(1000, 760); await capture.reducedMotion(true); await settle();
    yield { name: theme + '-narrow', inspect: ['.preset-creator'] };
    await capture.viewport(420, 780); await settle();
    yield { name: theme + '-compact', inspect: ['.preset-creator'] };
    await capture.press('Escape'); await capture.waitFor(() => !document.querySelector('.preset-creator'));
    await codexOutside();
    assert.equal(await capture.evaluate(() => document.querySelector('ex-composer textarea').value), 'Keep this message while I choose the harness.');
    await capture.viewport(1440, 960); await capture.reducedMotion(false);
    await capture.evaluate(() => document.querySelector('ex-session-chat .preset-heading > button').scrollIntoView({ block: 'center' }));
    await capture.settle();
    await capture.click('ex-session-chat .preset-heading > button'); await capture.waitFor(() => !!document.querySelector('.preset-creator'));
    const name = theme === 'light' ? 'Claude review' : 'Claude implementation';
    await capture.fill('.preset-creator input', name); await chooseHarness('Claude Code');
    await capture.waitFor(() => document.querySelector('.preset-creator button[aria-label^="Model:"]')?.textContent.includes('Sonnet'));
    await capture.click('.preset-creator button[type="submit"]');
    await capture.waitFor(() => !document.querySelector('.preset-creator'));
    await capture.waitFor(() => document.querySelector('ex-session-chat .provider')?.textContent.trim() === 'Claude Code');
    assert.equal(await capture.evaluate(name => document.querySelector('ex-preset-picker').textContent.includes(name), name), true);
    assert.equal(await capture.evaluate(() => document.querySelector('ex-composer textarea').value), 'Keep this message while I choose the harness.');
    await settle(); yield { name: theme + '-saved-harness', inspect: ['ex-preset-picker', 'ex-composer'] };
  }
}
