import assert from 'node:assert/strict';

/** Production chat and components, driven only by the isolated preview transport. */
export default async function* (capture) {
  await capture.evaluate(() => { location.href = '/connected-workspace'; });
  await capture.waitFor(() => !!document.querySelector('ex-workspace-navigation ex-task-list'));
  await capture.component('ex-machine-workspace', c => c.store.selectSession({ taskId: '11', sessionId: '101' }));
  await capture.waitFor(() => document.querySelector('ex-agent-picker > button')?.disabled === false);
  let reset = Math.floor(Date.now() / 1000) + 3600;
  const window = (id, label, left, resetsAt = reset) => ({ id, label, remainingPercentage: left, resetsAt });
  const usage = (provider, windows, status = 'available') => ({ provider, planName: provider === 'codex' ? 'Plus' : null, status, windows, updatedAt: new Date().toISOString() });
  const publish = value => capture.component('ex-connected-workspace-demo', (c, value) => c.fixture.chat.usage(value), value);
  const finish = async () => {
    await capture.settle();
    await capture.waitFor(() => document.getAnimations().every(a => !Number.isFinite(a.effect?.getComputedTiming().endTime) || a.playState !== 'running'));
  };
  const open = async () => {
    await capture.click('ex-agent-picker > button');
    await capture.waitFor(() => document.querySelector('.agent-settings')?.getAttribute('aria-hidden') === 'false');
    await finish();
  };
  const close = async () => {
    await capture.press('Escape');
    assert.equal(await capture.evaluate(() => document.activeElement === document.querySelector('ex-agent-picker > button')), true);
    await capture.click('ex-composer textarea');
    await capture.hover('.session-bar .provider');
    await capture.waitFor(() => !document.querySelector('.agent-settings, .usage-card'));
  };
  for (const theme of ['light', 'dark']) {
    // A distinct allowance window per theme keeps the intentional dismissal local.
    reset += 60;
    await capture.theme(theme); await capture.viewport(1440, 960);
    await publish(usage('codex', [window('primary', '5-hour limit', 64), window('secondary', 'Weekly limit', 82)]));
    await capture.waitFor(() => document.querySelector('ex-agent-plan-meter')?.getAttribute('aria-label').includes('64%'));
    assert.equal(await capture.evaluate(() => !!document.querySelector('ex-agent-usage-notice .notice')), false);
    assert.equal(await capture.evaluate(() => !!document.querySelector('ex-agent-plan-meter .number')), false);
    await capture.hover('ex-agent-picker > button');
    await capture.waitFor(() => !!document.querySelector('.usage-card:not(.leaving)')); await finish();
    assert.deepEqual(await capture.evaluate(() => [...document.querySelectorAll('.usage-card [role="meter"]')].map(e => e.getAttribute('aria-valuenow'))), ['64', '82']);
    yield { name: theme + '-quota-hover', inspect: ['.usage-card', 'ex-agent-plan-meter', '.limit'] };
    await open();
    assert.equal(await capture.evaluate(() => document.querySelector('.agent-settings')?.textContent.includes('Plus')), true);
    yield { name: theme + '-quota-menu', selector: '.agent-settings', inspect: ['.agent-settings', '.limit'] };
    await close();
    await publish(usage('codex', [window('primary', '5-hour limit', 12), window('secondary', 'Weekly limit', 58)], 'warning'));
    await capture.waitFor(() => document.querySelector('ex-agent-usage-notice')?.textContent.includes('12% of your 5-hour limit left'));
    await finish(); yield { name: theme + '-quota-low', inspect: ['ex-agent-usage-notice', 'ex-composer', 'ex-agent-plan-meter'] };
    await capture.click('ex-agent-usage-notice button');
    await capture.waitFor(() => !document.querySelector('ex-agent-usage-notice .notice'));
    assert.equal(await capture.evaluate(() => document.activeElement === document.querySelector('ex-composer textarea')), true);
    await publish(usage('codex', [window('primary', '5-hour limit', 10)], 'warning'));
    await capture.waitFor(() => document.querySelector('ex-agent-plan-meter')?.getAttribute('aria-label').includes('10%'));
    assert.equal(await capture.evaluate(() => !!document.querySelector('ex-agent-usage-notice .notice')), false);
    await publish(usage('codex', [window('primary', '5-hour limit', 0)], 'exhausted'));
    await capture.waitFor(() => document.querySelector('ex-agent-usage-notice')?.textContent.includes('Codex plan limit reached'));
    assert.equal(await capture.evaluate(() => !!document.querySelector('ex-agent-usage-notice button')), false);
    await finish(); yield { name: theme + '-quota-exhausted', inspect: ['ex-agent-usage-notice', 'ex-agent-plan-meter', 'ex-composer'] };
    await publish(usage('claude', [window('seven_day', 'Weekly limit', 18), window('seven_day_opus', 'Weekly Opus limit', 7)], 'warning'));
    await capture.waitFor(() => document.querySelector('ex-agent-plan-meter')?.getAttribute('aria-label').includes('7% of the weekly opus limit'));
    await capture.viewport(1000, 760); await capture.reducedMotion(true); await open();
    const limits = await capture.evaluate(() => [...document.querySelectorAll('.agent-settings .limit-label')].map(e => e.textContent));
    assert.deepEqual(limits, ['Weekly limit', 'Weekly Opus limit']);
    yield { name: theme + '-quota-weekly-narrow', inspect: ['.agent-settings', '.limit', 'ex-composer'] };
    await close();
    await publish(usage('claude', [window('seven_day', 'Weekly limit', 0, Math.floor(Date.now() / 1000) - 60)], 'exhausted'));
    await capture.waitFor(() => document.querySelector('ex-agent-usage-notice')?.textContent.includes('awaiting usage update'));
    assert.equal(await capture.evaluate(() => document.querySelector('ex-agent-plan-meter .number')?.textContent.trim()), 'Reset due');
    await finish(); yield { name: theme + '-quota-reset-pending', inspect: ['ex-agent-usage-notice', 'ex-agent-plan-meter'] };
    await publish(null);
    await capture.waitFor(() => !document.querySelector('ex-agent-plan-meter, ex-agent-usage-notice .notice'));
    await open();
    assert.equal(await capture.evaluate(() => !!document.querySelector('.plan-heading, .limit')), false);
    await close(); await capture.reducedMotion(false);
  }
}
