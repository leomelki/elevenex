import assert from 'node:assert/strict';

/** Antigravity context and per-model quota through the production chat and preview transport. */
export default async function* (capture) {
  await capture.evaluate(() => { location.href = '/connected-workspace'; });
  await capture.waitFor(() => !!document.querySelector('ex-workspace-navigation ex-task-list'));
  await capture.component('ex-machine-workspace', c => c.store.selectSession({ taskId: '11', sessionId: '101' }));
  await capture.waitFor(() => document.querySelector('ex-agent-picker > button')?.disabled === false);
  const opus = 'claude-opus-4-6-thinking', sonnet = 'claude-sonnet-4-6', flash = 'gemini-3.8-flash';
  const quota = models => ({ provider: 'antigravity', tier: 'Antigravity Starter Quota', updatedAt: new Date().toISOString(), models });
  const exhausted = (id, label, resetsAt) => ({ id, label, remainingPercentage: null, exhausted: true, resetsAt });
  const context = (tokens, limit = 1048576) => ({ tokens, limit, percentage: Math.round(tokens / limit * 1000) / 10 });
  const publish = (modelQuota, usage, model) =>
    capture.component('ex-connected-workspace-demo', (c, [q, u, m]) => c.fixture.chat.antigravityUsage(q, u, m), [modelQuota, usage, model]);
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
    await capture.hover('ex-session-chat ex-chat-scroll');
    await capture.waitFor(() => !document.querySelector('.agent-settings, .usage-card'));
  };
  for (const theme of ['light', 'dark']) {
    await capture.theme(theme); await capture.viewport(1440, 960); await capture.reducedMotion(false);
    // Tier alone is not a measured allowance: only context is shown.
    await publish(quota([]), context(186_000), opus);
    await capture.waitFor(() => !!document.querySelector('ex-agent-picker ex-context-meter'));
    assert.equal(await capture.evaluate(() => !!document.querySelector('ex-agent-plan-meter, ex-agent-usage-notice .notice')), false);
    await capture.hover('ex-agent-picker > button');
    await capture.waitFor(() => !!document.querySelector('.usage-card:not(.leaving)')); await finish();
    assert.match(await capture.evaluate(() => document.querySelector('.usage-card').textContent), /186k of 1(\.\d+)?m/i);
    yield { name: theme + '-antigravity-context', inspect: ['.usage-card', 'ex-agent-picker'] };
    await capture.hover('ex-session-chat ex-chat-scroll');
    await capture.waitFor(() => !document.querySelector('.usage-card'));

    // The selected model runs out; another one also has a reported reset.
    const reset = Math.floor(Date.now() / 1000) + 2.5 * 3600;
    await publish(quota([exhausted(opus, 'Claude Opus 4.6 (Thinking)', reset), exhausted(sonnet, 'Claude Sonnet 4.6 (Thinking)', reset + 1800)]), context(186_000), opus);
    await capture.waitFor(() => document.querySelector('ex-agent-usage-notice')?.textContent.includes('Claude Opus 4.6 (Thinking) is out of quota.'));
    assert.match(await capture.evaluate(() => document.querySelector('ex-agent-usage-notice').textContent), /Resets at .*Choose another model to continue now\./);
    assert.equal(await capture.evaluate(() => !!document.querySelector('ex-agent-usage-notice button')), false);
    assert.match(await capture.evaluate(() => document.querySelector('ex-agent-plan-meter').getAttribute('aria-label')), /^Claude Opus 4\.6 \(Thinking\) quota used up, resets /);
    await finish(); yield { name: theme + '-antigravity-exhausted', inspect: ['ex-agent-usage-notice', 'ex-agent-plan-meter', 'ex-composer'] };
    await capture.hover('ex-agent-picker > button');
    await capture.waitFor(() => !!document.querySelector('.usage-card:not(.leaving)')); await finish();
    assert.match(await capture.evaluate(() => document.querySelector('.usage-card').textContent), /Antigravity\s*Starter Quota[\s\S]*Claude Opus 4\.6 \(Thinking\)\s*Used up/);
    yield { name: theme + '-antigravity-hover', inspect: ['.usage-card', '.limit'] };
    await open();
    const rows = await capture.evaluate(() => [...document.querySelectorAll('.agent-settings [role="option"]')].map(row => ({
      label: row.querySelector('.label').textContent.trim(), quota: row.querySelector('.quota')?.textContent.trim() ?? null, tone: row.querySelector('.quota')?.dataset.tone ?? null,
    })));
    assert.deepEqual(rows.map(row => [row.label, !!row.quota, row.tone]), [
      ['Gemini 3.8 Flash', false, null],
      ['Claude Sonnet 4.6 (Thinking)', true, 'danger'],
      ['Claude Opus 4.6 (Thinking)', true, 'danger'],
      ['GPT-OSS 120B (Medium)', false, null],
    ]);
    assert.match(rows[2].quota, /^, quota Used up · \d\d:\d\d$/);
    assert.match(await capture.evaluate(() => document.querySelector('.agent-settings .plan').textContent.trim()), /^Used up · \d\d:\d\d$/);
    yield { name: theme + '-antigravity-menu', selector: '.agent-settings', inspect: ['.agent-settings', '.quota', '.plan'] };
    await close();

    // Choosing a model with room clears the selected-model surfaces.
    await publish(quota([exhausted(opus, 'Claude Opus 4.6 (Thinking)', reset)]), context(4_096), flash);
    await capture.waitFor(() => !document.querySelector('ex-agent-plan-meter, ex-agent-usage-notice .notice'));
    await capture.viewport(1000, 760); await capture.reducedMotion(true); await open();
    assert.equal(await capture.evaluate(() => !!document.querySelector('.agent-settings .plan')), false);
    assert.equal(await capture.evaluate(() => document.querySelectorAll('.agent-settings .quota').length), 1);
    yield { name: theme + '-antigravity-switched-narrow', selector: '.agent-settings', inspect: ['.agent-settings', '.quota'] };
    await close(); await capture.reducedMotion(false);
  }
}
