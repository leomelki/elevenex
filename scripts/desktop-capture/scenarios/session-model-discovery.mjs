import assert from 'node:assert/strict';

/** A cold conversation must discover models, show failures, and recover in place. */
export default async function* (capture) {
  await capture.evaluate(() => { location.href = '/connected-workspace'; });
  await capture.waitFor(() => !!document.querySelector('ex-workspace-navigation ex-task-list'));
  await capture.component('ex-connected-workspace-demo', c => {
    c.fixture.chat.coldModels(102);
  });
  await capture.component('ex-machine-workspace', c => c.store.selectSession({ taskId: '11', sessionId: '102' }));
  await capture.waitFor(() => !!document.querySelector('ex-agent-picker > button'));
  const finish = async () => {
    await capture.settle();
    await capture.waitFor(() => document.getAnimations().every(a => !Number.isFinite(a.effect?.getComputedTiming().endTime) || a.playState !== 'running'));
  };
  for (const theme of ['light', 'dark']) {
    await capture.theme(theme);
    await capture.viewport(theme === 'light' ? 1440 : 1000, theme === 'light' ? 960 : 760);
    await capture.reducedMotion(theme === 'dark');
    await capture.fill('ex-composer textarea', 'Keep this unsent message');
    await capture.component('ex-connected-workspace-demo', c => c.fixture.chat.catalogBehavior(4000, true));
    await capture.component('ex-session-chat', c => { c.modelCatalog.reset(); c.refreshModels(); });
    await capture.click('ex-agent-picker > button');
    await capture.waitFor(() => document.querySelector('.agent-settings')?.getAttribute('aria-busy') === 'true');
    await finish();
    yield { name: theme + '-loading-models', inspect: ['.agent-settings', '.agent-settings button', 'ex-composer textarea'] };
    await capture.waitFor(() => document.querySelector('.agent-settings')?.textContent.includes('Could not load'));
    await finish();
    yield { name: theme + '-discovery-failed', inspect: ['.agent-settings', '.agent-settings [role=status]'] };
    await capture.component('ex-connected-workspace-demo', c => c.fixture.chat.catalogBehavior(300, false));
    const refresh = await capture.evaluate(() => {
      const buttons = [...document.querySelectorAll('.agent-settings button')];
      const index = buttons.findIndex(b => b.textContent.includes('Refresh models'));
      buttons[index].setAttribute('data-capture-refresh', '');
      return index >= 0;
    });
    assert.equal(refresh, true);
    await capture.click('[data-capture-refresh]');
    await capture.waitFor(() => document.querySelector('.agent-settings')?.getAttribute('aria-busy') === 'false' && !!document.querySelector('.agent-settings [role=option]'));
    assert.equal(await capture.evaluate(() => document.querySelector('.agent-settings [role=option]').textContent.includes('GPT-6')), true);
    assert.equal(await capture.evaluate(() => document.querySelector('ex-composer textarea').value), 'Keep this unsent message');
    await finish();
    yield { name: theme + '-models-recovered', inspect: ['.agent-settings', '.agent-settings [role=option]', 'ex-composer'] };
    await capture.press('Escape');
    await capture.waitFor(() => !document.querySelector('.agent-settings'));
    assert.equal(await capture.evaluate(() => document.activeElement === document.querySelector('ex-agent-picker > button')), true);
  }
  assert.equal(await capture.component('ex-connected-workspace-demo', c => c.fixture.sentChatActions.length), 0);
}
