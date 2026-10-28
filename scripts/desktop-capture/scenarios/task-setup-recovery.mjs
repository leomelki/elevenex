import assert from 'node:assert/strict';

/** Public UI recovery of a saved task; Git/file preservation has real backend tests. */
export default async function* (capture) {
  await capture.evaluate(() => { if (location.pathname !== '/connected-workspace') location.href = '/connected-workspace'; });
  await capture.waitFor(() => document.querySelector('ex-workspace-navigation ex-task-list'));
  const owner = fn => capture.component('ex-machine-workspace', fn);
  const finish = async () => {
    await capture.settle();
    await capture.waitFor(() => document.getAnimations().every(animation => !Number.isFinite(animation.effect?.getComputedTiming().endTime) || animation.playState !== 'running'));
  };
  await capture.component('ex-connected-workspace-demo', component => component.fixture.setTaskSetupFailure(true));
  for (const theme of ['light', 'dark']) for (const recovery of ['use-existing', 'snapshot']) {
    await capture.theme(theme); await capture.viewport(1280, 900);
    await owner(component => component.store.openNewTask('1'));
    await capture.waitFor(() => document.activeElement?.getAttribute('aria-label') === 'Task name');
    await finish();
    await capture.fill('input[aria-label="Task name"]', `Recover existing branch ${theme} ${recovery}`);
    await capture.press('Enter');
    await capture.waitFor(() => document.activeElement?.getAttribute('aria-label') === 'Branch: type to search or create');
    await finish();
    await capture.fill('input[aria-label="Branch: type to search or create"]', 'release/stable');
    await capture.waitFor(() => !document.querySelector('ex-new-task [role="status"]'));
    await capture.press('Enter'); await finish(); await capture.press('Enter');
    await capture.waitFor(() => document.querySelector('ex-workspace-task-setup [role="alert"]')?.textContent.includes('already checked out'));
    await finish();
    const taskId = await owner(component => component.store.pendingTask()?.id);
    assert.equal(typeof taskId, 'number');
    assert.equal(await capture.evaluate(() => document.querySelector('ex-workspace-task-setup code')?.textContent), '/preview/existing-workspace');
    const previousRecoveries = await capture.component('ex-connected-workspace-demo', component => component.fixture.taskRecoveries.length);
    yield { name: `${theme}-${recovery}-choice`, inspect: ['ex-workspace-task-setup', 'ex-workspace-task-setup .actions'] };
    if (recovery === 'use-existing') {
      await capture.viewport(390, 740); await capture.reducedMotion(true); await finish();
      assert.equal(await capture.evaluate(() => document.querySelector('ex-workspace-task-setup').scrollWidth <= document.querySelector('ex-workspace-task-setup').clientWidth), true);
      yield { name: `${theme}-recovery-narrow`, inspect: ['ex-workspace-task-setup'] };
      await capture.viewport(1280, 900); await capture.reducedMotion(false); await finish();
    }
    await capture.click(recovery === 'use-existing' ? 'ex-workspace-task-setup .actions button[data-variant="primary"]' : 'ex-workspace-task-setup .actions button[data-variant="secondary"]');
    await capture.waitFor(() => !!document.querySelector('ex-workspace-task-header h1'));
    await finish();
    assert.equal(await owner(component => component.store.selectedTask()?.id), taskId, 'recovery keeps the saved task identity');
    const calls = await capture.component('ex-connected-workspace-demo', component => component.fixture.taskRecoveries);
    assert.equal(calls.length, previousRecoveries + 1);
    assert.deepEqual(calls.at(-1), { taskId, recovery });
    yield { name: `${theme}-${recovery}-ready`, inspect: ['ex-workspace-task-header', 'ex-workspace-navigation'] };
  }
}
