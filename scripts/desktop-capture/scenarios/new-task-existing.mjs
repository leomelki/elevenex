import assert from 'node:assert/strict';

/** Existing-branch creation through the connected owner and trusted native Enter. */
export default async function* (capture) {
  await capture.evaluate(() => { if (location.pathname !== '/connected-workspace') location.href = '/connected-workspace'; });
  await capture.waitFor(() => document.querySelector('ex-workspace-navigation ex-task-list'));
  const owner = fn => capture.component('ex-machine-workspace', fn);
  const finish = async () => {
    await capture.settle();
    await capture.waitFor(() => document.getAnimations().every(animation => !Number.isFinite(animation.effect?.getComputedTiming().endTime) || animation.playState !== 'running'));
  };
  for (const theme of ['light', 'dark']) {
    await capture.theme(theme); await capture.viewport(1280, 900);
    await owner(component => component.store.selectProject('1'));
    await owner(component => component.store.openNewTask());
    await capture.waitFor(() => document.activeElement?.getAttribute('aria-label') === 'Task name');
    await capture.fill('input[aria-label="Task name"]', `Continue existing branch ${theme}`);
    await capture.press('Enter');
    await capture.waitFor(() => document.activeElement?.getAttribute('aria-label') === 'Branch: type to search or create');
    await finish();
    await capture.fill('input[aria-label="Branch: type to search or create"]', 'release/stable');
    await capture.waitFor(() => !document.querySelector('ex-new-task [role="status"]'));
    await capture.press('Enter');
    await capture.waitFor(() => document.querySelector('ex-new-task .skip-note')?.textContent.includes('already exists and keeps its history'));
    await finish();
    assert.equal(await capture.evaluate(() => document.querySelector('ex-new-task footer .next').disabled), false);
    assert.equal(await capture.evaluate(() => document.activeElement === document.querySelector('ex-new-task footer .next')), true);
    assert.equal(await owner(component => component.store.branchLoading()), false);
    yield { name: `${theme}-existing-history-ready`, inspect: ['.dialog', 'ex-new-task .skip-note', 'ex-new-task footer .next'] };
    await capture.press('Enter');
    await capture.waitFor(() => document.querySelector('ex-workspace-task-header h1')?.textContent.includes(`Continue existing branch ${document.documentElement.dataset.theme}`));
    await finish();
    assert.equal(await owner(component => component.store.selectedTask()?.branchName), 'release/stable');
    assert.equal(await capture.evaluate(() => !!document.querySelector('[role="dialog"]')), false);
    yield { name: `${theme}-existing-task-created-by-enter`, inspect: ['ex-workspace-task-header', 'ex-workspace-navigation'] };
  }
}
