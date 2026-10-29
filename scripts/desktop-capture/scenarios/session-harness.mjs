import assert from 'node:assert/strict';

export default async function* (capture) {
  await capture.evaluate(() => { location.href = '/connected-workspace'; });
  await capture.waitFor(() => !!document.querySelector('ex-workspace-navigation ex-task-list'));
  const select = id => capture.component('ex-machine-workspace', (c, id) => c.store.selectSession({ taskId: '11', sessionId: id }), id);
  const finish = async () => { await capture.settle(); await capture.waitFor(() => document.getAnimations().every(a => !Number.isFinite(a.effect?.getComputedTiming().endTime) || a.playState !== 'running')); };
  const choose = async (key, label) => {
    await capture.click('ex-agent-picker > button');
    await capture.waitFor(() => !!document.querySelector('.agent-settings [aria-label="Harness"]'));
    // Initial focus is the section heading, followed by the current harness radio.
    await capture.press('Tab'); await capture.press(key);
    await capture.waitFor(label => document.querySelector('ex-session-chat .provider')?.textContent.includes(label), label);
    await capture.waitFor(() => !document.querySelector('.agent-settings'));
    assert.equal(await capture.evaluate(() => document.querySelector('ex-composer textarea').value), 'Keep my message while changing agents');
  };
  await select('102');
  for (const theme of ['light', 'dark']) {
    await capture.theme(theme); await capture.viewport(1440, 960);
    await capture.waitFor(() => document.querySelector('ex-agent-picker > button')?.disabled === false);
    await capture.fill('ex-composer textarea', 'Keep my message while changing agents');
    await capture.click('ex-agent-picker > button');
    await capture.waitFor(() => !!document.querySelector('.agent-settings [aria-label="Harness"]'));
    const labels = await capture.evaluate(() => [...document.querySelectorAll('.agent-settings [aria-label="Harness"] button')].map(b => b.textContent.trim()));
    assert.deepEqual(labels, ['Claude Code', 'Codex', 'Pi', 'OpenCode']);
    await finish();
    yield { name: theme + '-harness-choices', inspect: ['ex-composer', '.agent-settings'] };
    await capture.press('Escape'); await capture.waitFor(() => !document.querySelector('.agent-settings'));
    await choose('Home', 'Claude Code');
    await capture.click('ex-agent-picker > button');
    await capture.waitFor(() => !!document.querySelector('.agent-settings button[aria-label^="Model:"]'));
    assert.equal(await capture.evaluate(() => document.querySelector('.agent-settings button[aria-label^="Model:"]').textContent.includes('Sonnet')), true);
    await finish(); yield { name: theme + '-claude-selected', inspect: ['ex-composer', '.agent-settings'] };
    await capture.press('Escape'); await capture.waitFor(() => !document.querySelector('.agent-settings'));
    await choose('End', 'OpenCode'); await choose('ArrowLeft', 'Pi'); await choose('ArrowLeft', 'Codex');
    await capture.viewport(1000, 760); await capture.reducedMotion(true); await finish();
    yield { name: theme + '-narrow-harness', inspect: ['ex-composer', 'ex-composer .bar'] };
    await capture.reducedMotion(false);
  }
  await capture.fill('ex-composer textarea', 'Start with Codex'); await capture.press('Enter');
  await capture.waitFor(() => document.querySelector('ex-agent-picker > button')?.disabled === false);
  await capture.click('ex-agent-picker > button'); await capture.waitFor(() => !!document.querySelector('.agent-settings .harness'));
  await finish(); yield { name: 'started-harness-locked', inspect: ['ex-composer', '.agent-settings'] };
  await capture.press('Escape'); await capture.waitFor(() => !document.querySelector('.agent-settings'));
  await select('101'); await capture.waitFor(() => document.querySelector('ex-agent-picker > button')?.disabled === false);
  await capture.click('ex-agent-picker > button'); await capture.waitFor(() => !!document.querySelector('.agent-settings .harness'));
  await capture.press('Escape'); await capture.waitFor(() => !document.querySelector('.agent-settings'));
}
