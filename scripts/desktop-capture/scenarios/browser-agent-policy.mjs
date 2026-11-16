import assert from 'node:assert/strict';

/** Real browser owner; only the preview store's advertised host capability varies. */
export default async function* browserAgentPolicy(capture) {
  await capture.evaluate(() => { location.href = '/task-browser'; });
  await capture.waitFor(() => document.querySelector('.start-page'));
  for (const theme of ['light', 'dark']) {
    await capture.theme(theme);
    await capture.component('ex-task-browser', component => {
      component.store.state.update(state => ({ ...state, agentCode: 1 }));
      component.showDialog('tools');
    });
    await capture.waitFor(() => document.querySelector('.privacy')?.textContent.includes('Block agent prevents access'));
    await capture.motion.finish();
    assert.equal(await capture.evaluate(() => document.querySelector('.privacy')?.textContent.includes('observation is withheld')), false);
    yield { name: theme + '-agent-access', inspect: ['[role="dialog"]', '.privacy', '.feedback'] };
    await capture.press('Escape');
    await capture.waitFor(() => !document.querySelector('[role="dialog"]'));
  }
  await capture.viewport(520, 800); await capture.reducedMotion(true);
  await capture.component('ex-task-browser', component => component.showDialog('tools'));
  await capture.waitFor(() => document.querySelector('.privacy'));
  yield { name: 'narrow-agent-access', inspect: ['[role="dialog"]', '.privacy', '.feedback'] };
  await capture.component('ex-task-browser', component => {
    component.store.state.update(state => ({ ...state, agentCode: undefined }));
  });
  await capture.waitFor(() => document.querySelector('.privacy')?.textContent.includes('observation is withheld'));
  yield { name: 'legacy-host-policy', inspect: ['[role="dialog"]', '.privacy'] };
}
