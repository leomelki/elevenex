import assert from 'node:assert/strict';

/** Missing folders keep history readable; recovery keeps the same task/session. */
export default async function* (capture) {
  await capture.evaluate(() => { if (location.pathname !== '/connected-workspace') location.href = '/connected-workspace'; });
  await capture.waitFor(() => document.querySelector('ex-workspace-navigation ex-task-list'));
  for (const theme of ['light', 'dark']) {
    await capture.theme(theme); await capture.viewport(1280, 900);
    await capture.component('ex-connected-workspace-demo', component => component.fixture.setWorkspaceRecovery('prepare'));
    await capture.component('ex-machine-workspace', async component => {
      await component.store.refresh();
      component.store.selectSession({ taskId: '11', sessionId: '101' });
    });
    await capture.waitFor(() => document.querySelector('.workspace-recovery') && document.querySelector('ex-composer textarea:disabled'));
    yield { name: `${theme}-history-preserved`, inspect: ['.workspace-recovery', 'ex-composer', 'ex-workspace-navigation'] };
    await capture.click('.workspace-recovery button');
    await capture.waitFor(() => document.querySelector('ex-workspace-task-setup .actions button')?.textContent.includes('Prepare workspace'));
    yield { name: `${theme}-prepare-workspace`, inspect: ['ex-workspace-task-setup'] };
    await capture.viewport(390, 740); await capture.reducedMotion(true);
    assert.equal(await capture.evaluate(() => document.querySelector('ex-workspace-task-setup').scrollWidth <= document.querySelector('ex-workspace-task-setup').clientWidth), true);
    // Trusted keyboard input reaches the recovery action without a pointer.
    await capture.evaluate(() => document.querySelector('ex-workspace-task-setup .actions button').focus());
    yield { name: `${theme}-narrow-keyboard`, inspect: ['ex-workspace-task-setup .actions button'] };
    await capture.press('Enter');
    await capture.waitFor(() => !document.querySelector('ex-workspace-task-setup') && !document.querySelector('.workspace-recovery') && document.querySelector('ex-composer textarea:not(:disabled)'));
    assert.equal(await capture.component('ex-machine-workspace', component => component.store.selectedTask()?.id), 11);
    yield { name: `${theme}-ready`, inspect: ['ex-composer', 'ex-workspace-task-header'] };
    await capture.viewport(1280, 900); await capture.reducedMotion(false);
    for (const [recovery, label] of [['restore-branch', 'Restore branch'], ['new-workspace', 'Prepare separate workspace'], ['released', 'Prepare workspace']]) {
      await capture.component('ex-connected-workspace-demo', (component, value) => component.fixture.setWorkspaceRecovery(value), recovery);
      await capture.component('ex-machine-workspace', async component => { await component.store.refresh(); component.store.openEmptyTask('11'); });
      await capture.waitFor((text) => document.querySelector('ex-workspace-task-setup .actions button')?.textContent.includes(text), label);
      yield { name: `${theme}-${recovery}`, inspect: ['ex-workspace-task-setup'] };
      await capture.click('ex-workspace-task-setup .actions button');
      await capture.waitFor(() => !!document.querySelector('ex-workspace-task-header'));
      const calls = await capture.component('ex-connected-workspace-demo', component => component.fixture.taskRecoveries);
      assert.deepEqual(calls.at(-1), { taskId: 11, recovery: recovery === 'released' ? undefined : recovery });
    }
  }
}
