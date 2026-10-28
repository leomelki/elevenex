import assert from 'node:assert/strict';

/** Production sidebar with bounded preview data; selection must not move tasks. */
export default async function* (capture) {
  await capture.evaluate(() => { if (location.pathname !== '/connected-workspace') location.href = '/connected-workspace'; });
  await capture.waitFor(() => document.querySelector('ex-workspace-navigation ex-task-list'));
  const owner = fn => capture.component('ex-machine-workspace', fn);
  const finish = async () => {
    await capture.settle();
    await capture.waitFor(() => document.getAnimations().every(animation =>
      !Number.isFinite(animation.effect?.getComputedTiming().endTime) || animation.playState !== 'running'));
    await capture.settle();
  };
  const geometry = () => capture.evaluate(() =>
    [...document.querySelectorAll('ex-task-list [data-task-id]')].map(task => {
      const box = task.getBoundingClientRect();
      return { id: task.dataset.taskId, top: box.top, height: box.height };
    }));
  const inspect = ['ex-workspace-navigation', '[data-task-id="11"]', '[data-task-id="12"]', 'ex-tooltip'];
  for (const theme of ['light', 'dark']) {
    await capture.theme(theme); await capture.viewport(1440, 900); await capture.reducedMotion(false);
    await capture.component('ex-connected-workspace-demo', component => component.fixture.sidebarState('single'));
    await owner(async component => { await component.store.refresh(); await component.store.selectProject('1'); }); await finish();
    const before = await geometry();
    for (const selector of [
      '[data-task-id="11"] [data-session-id="101"] .select',
      '[data-task-id="12"] [data-session-id="103"] .select',
      '[data-task-id="11"] [data-session-id="102"] .select',
    ]) {
      await capture.click(selector);
      assert.deepEqual(await geometry(), before);
      await finish();
      assert.deepEqual(await geometry(), before);
      assert.equal(await capture.evaluate(() =>
        document.querySelectorAll('ex-task-list .new-session, ex-task-list .empty-session').length), 0);
    }
    yield { name: `${theme}-stable-selection`, inspect, metadata: { geometry: before } };
    const add = '[data-task-id="11"] header .add button';
    await capture.hover(add);
    await capture.waitFor(() => document.querySelector('ex-tooltip')?.textContent.includes('New session in this task'));
    await finish();
    yield { name: `${theme}-new-session-tooltip`, inspect };
    // Return the fold to its open state, then reach + through native Tab input.
    await capture.click('[data-task-id="11"] header .toggle');
    await capture.press('Enter'); await finish();
    await capture.hover('ex-workspace-navigation footer'); await capture.press('Tab');
    await capture.waitFor(() => document.querySelector('ex-tooltip')?.textContent.includes('New session in this task'));
    await finish();
    assert.equal(await capture.evaluate(() => document.activeElement?.matches('[data-task-id="11"] header .add button')), true);
    assert.notEqual(await capture.evaluate(() => getComputedStyle(document.activeElement).boxShadow), 'none');
    yield { name: `${theme}-keyboard-discovery`, inspect };
    await capture.press('Enter'); await finish();
    await capture.waitFor(() => document.querySelector('[data-task-id="11"] [aria-current="true"]')?.textContent.includes('Explore the task'));
    assert.equal(await capture.evaluate(() => !!document.querySelector('ex-task-list .empty-session')), false);

    // Archive both sessions in the second task through the isolated provider.
    await capture.component('ex-connected-workspace-demo', async component => {
      for (const sessionId of [103, 104]) await component.fixture.workspaceArchiveSession('preview', { taskId: 12, sessionId });
    });
    await owner(component => component.store.refresh()); await finish();
    const empty = '[data-task-id="12"] .empty-session';
    await capture.waitFor(() => document.querySelector('[data-task-id="12"] .empty-session')?.closest('[inert]') === null);
    await capture.reducedMotion(true); await capture.viewport(1000, 700); await finish();
    yield { name: `${theme}-empty-task-narrow-reduced`, inspect };
    await capture.click(empty); await finish();
    await capture.waitFor(() => document.querySelector('[data-task-id="12"] [aria-current="true"]')?.textContent.includes('Explore the task'));
    assert.equal(await capture.evaluate(() => {
      const action = document.querySelector('[data-task-id="12"] .empty-session');
      return !!action && !action.closest('[inert]');
    }), false);
    await owner(component => component.store.busy.set(true)); await finish();
    assert.equal(await capture.evaluate(() => document.querySelectorAll('ex-task-list header .add').length), 0);
    yield { name: `${theme}-creation-unavailable`, inspect };
    await owner(component => component.store.busy.set(false)); await capture.reducedMotion(false);
  }
}
