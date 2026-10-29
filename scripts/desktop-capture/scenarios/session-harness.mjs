import assert from 'node:assert/strict';

export default async function* (capture) {
  await capture.evaluate(() => { location.href = '/connected-workspace'; });
  await capture.waitFor(() => document.querySelector('ex-workspace-navigation ex-task-list'));
  const select = id => capture.component('ex-machine-workspace', (c, id) => c.store.selectSession({ taskId: '11', sessionId: id }), id);
  const finish = async () => { await capture.settle(); await capture.waitFor(() => document.getAnimations().every(a => !Number.isFinite(a.effect?.getComputedTiming().endTime) || a.playState !== 'running')); };
  await select('102');
  for (const theme of ['light', 'dark']) {
    await capture.theme(theme); await capture.viewport(1440, 960);
    await capture.waitFor(() => document.querySelector('ex-agent-picker > button')?.disabled === false);
    await capture.click('ex-agent-picker > button');
    await capture.waitFor(() => document.querySelector('.agent-settings button[aria-label^="Harness:"]')?.disabled === false);
    await capture.press('Escape');
    await capture.fill('ex-composer textarea', 'Keep my message while changing agents');
    await capture.click('ex-agent-picker > button');
    await capture.click('.agent-settings button[aria-label^="Harness:"]');
    await capture.waitFor(() => document.querySelector('ex-dropdown-menu[aria-label="Harness"]'));
    const labels = await capture.evaluate(() => [...document.querySelectorAll('ex-dropdown-menu[aria-label="Harness"] button')].map(b => b.querySelector('.option-text').textContent.trim()));
    assert.deepEqual(labels, ['Claude Code', 'Codex', 'Pi', 'OpenCode']);
    yield { name: theme + '-harness-menu', inspect: ['ex-composer', 'ex-dropdown-menu'] };
    await capture.press('Home'); await capture.press('Enter');
    await capture.waitFor(() => document.querySelector('ex-session-chat .provider')?.textContent.includes('Claude Code'));
    assert.equal(await capture.evaluate(() => document.querySelector('ex-composer textarea').value), 'Keep my message while changing agents');
    await capture.click('ex-agent-picker > button');
    await capture.waitFor(() => document.querySelector('.agent-settings button[aria-label^="Model:"]'));
    assert.equal(await capture.evaluate(() => document.querySelector('.agent-settings button[aria-label^="Model:"]')?.textContent.includes('Sonnet')), true);
    yield { name: theme + '-claude-selected', inspect: ['ex-session-chat .session-bar', 'ex-composer'] };
    await capture.click('.agent-settings button[aria-label^="Harness:"]');
    await capture.press('End'); await capture.press('Enter');
    await capture.waitFor(() => document.querySelector('ex-session-chat .provider')?.textContent.includes('OpenCode'));
    await capture.click('ex-agent-picker > button');
    await capture.click('.agent-settings button[aria-label^="Harness:"]');
    await capture.press('Home'); await capture.press('ArrowDown'); await capture.press('Enter');
    await capture.waitFor(() => document.querySelector('ex-session-chat .provider')?.textContent.includes('Codex'));
    await capture.viewport(1000, 760); await capture.reducedMotion(true); await finish();
    yield { name: theme + '-narrow-harness', inspect: ['ex-composer', 'ex-composer .bar'] };
    await capture.reducedMotion(false);
  }
  await capture.fill('ex-composer textarea', 'Start with Codex'); await capture.press('Enter');
  await capture.click('ex-agent-picker > button');
  await capture.waitFor(() => document.querySelector('.agent-settings .harness'));
  await finish();
  yield { name: 'started-harness-locked', inspect: ['ex-composer', 'ex-session-chat .session-bar'] };
  await capture.press('Escape');
  await select('101'); await capture.click('ex-agent-picker > button');
  await capture.waitFor(() => document.querySelector('.agent-settings .harness'));
  await capture.press('Escape');
}
