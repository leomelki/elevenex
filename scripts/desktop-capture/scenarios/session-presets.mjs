import assert from 'node:assert/strict';

export default async function* (capture) {
  await capture.evaluate(() => { location.href = '/connected-workspace'; });
  await capture.waitFor(() => !!document.querySelector('ex-workspace-navigation ex-task-list'));
  await capture.component('ex-machine-workspace', c => c.store.selectSession({ taskId: '11', sessionId: '102' }));
  const settle = async () => {
    await capture.settle();
    await capture.waitFor(() => document.getAnimations().every(a => !Number.isFinite(a.effect?.getComputedTiming().endTime) || a.playState !== 'running'));
  };
  for (const theme of ['light', 'dark']) {
    await capture.theme(theme); await capture.viewport(1440, 960);
    await capture.waitFor(() => !!document.querySelector('ex-session-chat .start ex-preset-picker'));
    await capture.fill('ex-composer textarea', 'Keep my question while choosing a preset');
    await settle();
    yield { name: theme + '-blank-chat', inspect: ['ex-session-chat .start', 'ex-preset-picker', 'ex-composer'] };
    const quickIndex = await capture.evaluate(() => [...document.querySelectorAll('ex-preset-picker ex-preset-card')].findIndex(card => card.textContent.includes('Quick pass')));
    await capture.click(`ex-preset-picker ex-preset-card:nth-child(${quickIndex + 1}) button`);
    await capture.waitFor(() => document.querySelector('ex-preset-picker button[aria-pressed="true"]')?.textContent.includes('Quick pass'));
    assert.equal(await capture.evaluate(() => document.querySelector('ex-composer textarea').value), 'Keep my question while choosing a preset');
    assert.equal(await capture.evaluate(() => document.activeElement === document.querySelector('ex-composer textarea')), true);
    await capture.click('ex-preset-picker button.custom');
    await capture.waitFor(() => document.activeElement?.matches('.preset-creator input'));
    assert.equal(await capture.evaluate(() => !!document.querySelector('.agent-settings')), false);
    assert.equal(await capture.evaluate(() => document.querySelector('.preset-creator input').value), '');
    assert.equal(await capture.evaluate(() => document.querySelector('.preset-creator button[aria-label^="Harness:"]').textContent.includes('Codex')), true);
    assert.equal(await capture.evaluate(() => document.querySelector('.preset-creator button[aria-label^="Model:"]').textContent.includes('GPT-6')), true);
    assert.equal(await capture.evaluate(() => document.querySelector('.preset-creator [aria-label="Thinking level"] button[aria-checked="true"]').getAttribute('aria-label')), 'Low');
    assert.equal(await capture.evaluate(() => document.querySelector('.preset-creator [role="switch"]').getAttribute('aria-checked')), 'true');
    await settle(); yield { name: theme + '-custom-current-config', inspect: ['.preset-creator'] };
    await capture.click('.preset-creator [aria-label="Thinking level"] button[aria-label="High"]');
    await capture.press('Escape'); await capture.waitFor(() => !document.querySelector('.preset-creator'));
    assert.equal(await capture.evaluate(() => document.activeElement === document.querySelector('ex-preset-picker button.custom')), true);
    assert.equal(await capture.evaluate(() => document.querySelector('ex-preset-picker button[aria-pressed="true"]').textContent.includes('Quick pass')), true);
    assert.equal(await capture.evaluate(() => document.querySelector('ex-composer textarea').value), 'Keep my question while choosing a preset');
    await capture.click('ex-composer textarea');
    const deepIndex = await capture.evaluate(() => [...document.querySelectorAll('ex-preset-picker ex-preset-card')].findIndex(card => card.textContent.includes('Deep work')));
    await capture.press(String(deepIndex + 1), 1);
    await capture.waitFor(() => document.querySelector('ex-preset-picker button[aria-pressed="true"]')?.textContent.includes('Deep work'));
    const opener = 'ex-session-chat .preset-heading > button';
    await settle();
    await capture.motion.freeze(); await capture.click(opener);
    for (const time of [0, 140, 280]) {
      await capture.evaluate(time => {
        for (const animation of document.getAnimations()) {
          const target = animation.effect?.target;
          if (target && typeof target.closest === 'function' && target.closest('.ex-modal-layer, [data-modal-background]') && Number.isFinite(animation.effect.getComputedTiming().endTime))
            animation.currentTime = time;
        }
      }, time);
      await capture.settle();
      yield { name: theme + '-creator-opening-' + time, inspect: ['.preset-creator'], metadata: { animationTimeMs: time } };
    }
    await capture.motion.finish(); await capture.motion.play();
    await capture.waitFor(() => document.activeElement?.matches('.preset-creator input'));
    await capture.fill('.preset-creator input', 'deep WORK');
    assert.equal(await capture.evaluate(() => document.querySelector('.preset-creator input').getAttribute('aria-invalid')), 'true');
    assert.equal(await capture.evaluate(() => document.querySelector('.preset-creator button[type="submit"]').disabled), true);
    await settle(); yield { name: theme + '-duplicate-name', inspect: ['.preset-creator'] };
    await capture.fill('.preset-creator input', theme === 'light' ? 'Careful review' : 'Ship it');
    await capture.click('.preset-creator [aria-label="Thinking level"] button[aria-label="Low"]');
    assert.equal(await capture.evaluate(() => document.querySelector('.preset-creator [aria-label="Thinking level"] button[aria-checked="true"]').getAttribute('aria-label')), 'Low');
    await settle(); yield { name: theme + '-creator', inspect: ['.preset-creator'] };
    await capture.viewport(1000, 760); await capture.reducedMotion(true); await settle();
    yield { name: theme + '-narrow-creator', inspect: ['.preset-creator'] };
    await capture.click('.preset-creator button[type="submit"]');
    await capture.waitFor(() => !document.querySelector('.preset-creator'));
    await capture.waitFor(theme => document.querySelector('ex-preset-picker button[aria-pressed="true"]')?.textContent.includes(theme === 'light' ? 'Careful review' : 'Ship it'), theme);
    assert.equal(await capture.evaluate(() => document.querySelector('ex-composer textarea').value), 'Keep my question while choosing a preset');
    await settle(); yield { name: theme + '-created', inspect: ['ex-session-chat .start', 'ex-composer'] };
    await capture.click(opener); await capture.waitFor(() => !!document.querySelector('.preset-creator'));
    await capture.press('Escape'); await capture.waitFor(() => !document.querySelector('.preset-creator'));
    assert.equal(await capture.evaluate(() => document.activeElement === document.querySelector('ex-session-chat .preset-heading > button')), true);
    await capture.reducedMotion(false);
    // Return to the original six-or-fewer starting choices for the next theme.
    await capture.click('ex-preset-picker ex-preset-card button[aria-pressed="true"]');
  }
  await capture.click('ex-composer ex-agent-picker > button');
  await capture.waitFor(() => !!document.querySelector('.agent-settings'));
  await capture.click('.agent-settings footer button');
  await capture.waitFor(() => !!document.querySelector('.preset-creator'));
  await settle(); yield { name: 'save-current-mix', inspect: ['.preset-creator'] };
  await capture.press('Escape'); await capture.waitFor(() => !document.querySelector('.preset-creator'));
  await capture.fill('ex-composer textarea', 'Start with this preset'); await capture.press('Enter');
  await capture.waitFor(() => !document.querySelector('ex-session-chat .start'));
  assert.equal(await capture.evaluate(() => !!document.querySelector('ex-session-chat ex-preset-picker')), false);
  await settle(); yield { name: 'started-conversation', inspect: ['ex-composer', 'ex-chat'] };
}
