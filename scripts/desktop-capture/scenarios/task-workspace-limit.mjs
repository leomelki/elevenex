import assert from 'node:assert/strict';

/** Quota recovery through the production workspace with bounded preview data. */
export default async function* (capture) {
  await capture.evaluate(() => { if (location.pathname !== '/connected-workspace') location.href = '/connected-workspace'; });
  await capture.waitFor(() => document.querySelector('ex-workspace-navigation ex-task-list'));
  await capture.component('ex-connected-workspace-demo', component => component.fixture.setTaskSetupFailure('worktree-limit'));
  for (const theme of ['light', 'dark']) {
    await capture.theme(theme); await capture.viewport(1280, 900);
    await capture.component('ex-machine-workspace', async component => {
      await component.store.openNewTask('1');
      await component.store.createTask({ title: 'test', branch: 'test', base: null, existing: true, workspace: 'auto' });
    });
    await capture.waitFor(() => document.querySelector('ex-workspace-task-setup [role="alert"]')?.textContent.includes('23 workspaces'));
    await capture.waitFor(() => !document.querySelector('ex-workspace-task-setup button[disabled]'));
    const taskId = await capture.component('ex-machine-workspace', component => component.store.pendingTask()?.id);
    const previous = await capture.component('ex-connected-workspace-demo', component => component.fixture.taskRecoveries.length);
    const button = 'ex-workspace-task-setup button[data-variant="primary"]';
    await capture.evaluate(selector => document.querySelector(selector).focus(), button);
    assert.equal(await capture.evaluate(selector => document.activeElement === document.querySelector(selector), button), true);
    yield { name: `${theme}-workspace-limit`, inspect: ['ex-workspace-task-setup', button] };
    await capture.viewport(390, 740); await capture.reducedMotion(true); await capture.settle();
    assert.equal(await capture.evaluate(() => {
      const element = document.querySelector('ex-workspace-task-setup');
      return element.scrollWidth <= element.clientWidth;
    }), true);
    yield { name: `${theme}-workspace-limit-narrow`, inspect: ['ex-workspace-task-setup', 'ex-workspace-task-setup .actions'] };
    await capture.press('Enter');
    await capture.waitFor(() => !!document.querySelector('ex-workspace-task-header h1'));
    assert.equal(await capture.component('ex-machine-workspace', component => component.store.selectedTask()?.id), taskId);
    const calls = await capture.component('ex-connected-workspace-demo', component => component.fixture.taskRecoveries);
    assert.equal(calls.length, previous + 1);
    assert.deepEqual(calls.at(-1), { taskId, recovery: 'exceed-worktree-limit' });
    yield { name: `${theme}-workspace-ready`, inspect: ['ex-workspace-task-header'] };
    await capture.reducedMotion(false);
  }
}
