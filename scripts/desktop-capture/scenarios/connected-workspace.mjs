import assert from 'node:assert/strict';

/** Production composition with the isolated, typed backend adapter in preview/. */
export default async function* (capture) {
  await capture.evaluate(() => { location.href = '/connected-workspace'; });
  await capture.waitFor(() => document.querySelector('ex-workspace-navigation ex-task-list'));
  const owner = (fn, data) => capture.component('ex-machine-workspace', fn, data);
  const finish = async () => {
    await capture.settle();
    await capture.waitFor(() => document.getAnimations().every(animation => !Number.isFinite(animation.effect?.getComputedTiming().endTime) || animation.playState !== 'running'));
    await capture.settle();
  };
  for (const theme of ['light', 'dark']) {
    await capture.viewport(1440, 960); await capture.theme(theme);
    await owner(component => component.store.selectProject('all'));
    await owner(component => component.store.selectSession({ taskId: '11', sessionId: '101' }));
    await capture.waitFor(() => document.querySelector('ex-workspace-task-header'));
    await finish();
    assert.equal(await capture.evaluate(() => document.querySelectorAll('ex-title-bar').length), 1);
    assert.equal(await capture.evaluate(() => !!document.querySelector('ex-chat, ex-composer')), false);
    yield { name: `${theme}-workspace`, inspect: ['ex-app-shell .rail', 'ex-app-shell .sidebar', 'ex-app-shell .main', 'ex-workspace-task-header'] };

    await capture.click('ex-workspace-task-header [aria-label="Toggle side panel"]'); await finish();
    assert.equal(await capture.evaluate(() => Math.round(document.querySelector('ex-app-shell .panel').getBoundingClientRect().width)), 440);
    yield { name: `${theme}-panel`, inspect: ['ex-app-shell .main', 'ex-app-shell .panel', 'ex-workspace-panels'] };
    await capture.click('ex-workspace-panels [role="tab"][aria-label="Browser"]');
    await capture.press('Home'); await finish();
    assert.equal(await owner(component => component.panel()), 'terminal');
    assert.equal(await capture.evaluate(() => document.querySelector('ex-workspace-panels [role="tabpanel"]:not([hidden])')?.getAttribute('aria-label')), 'Terminal');
    await capture.click('ex-workspace-panels [role="tab"][aria-label="Changes"]');
    await capture.click('ex-workspace-panels [aria-label="Expand side panel"]'); await finish();
    assert.equal(await capture.evaluate(() => document.querySelector('ex-app-shell main').hasAttribute('inert')), true);
    yield { name: `${theme}-wide`, inspect: ['ex-app-shell .main', 'ex-app-shell .panel'] };
    await capture.press('Escape'); await finish();
    assert.equal(await capture.evaluate(() => document.querySelector('ex-app-shell main').hasAttribute('inert')), false);
    await capture.click('ex-workspace-panels [aria-label="Close side panel"]'); await finish();
    assert.equal(await capture.evaluate(() => document.querySelector('ex-app-shell .panel').hasAttribute('inert')), true);
    assert.equal(await capture.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Toggle side panel');

    if (theme === 'light') {
      await capture.click('ex-git-bar button.primary');
      await capture.waitFor(() => document.querySelector('ex-commit-panel .message input'));
      await finish();
      await capture.fill('ex-commit-panel .message input', 'Guard duplicate payment retries');
      await capture.press('Enter'); await finish();
      await capture.waitFor(() => document.querySelector('ex-git-bar button.primary')?.getAttribute('aria-label') === 'Commit 1');
      yield { name: 'light-committed', inspect: ['ex-workspace-task-header', 'ex-git-bar'] };
    }

    await owner(component => component.store.selectProject('1'));
    await finish();
    await capture.click('ex-workspace-navigation .project-title');
    await capture.press('Home');
    await capture.waitFor(() => document.activeElement?.getAttribute('role') === 'menuitem');
    await capture.press('Enter');
    await capture.waitFor(() => document.querySelector('[role="dialog"][aria-label="Project settings"]'));
    await finish();
    yield { name: `${theme}-project-settings`, inspect: ['ex-sheet', 'ex-workspace-project-settings'] };
    await capture.press('Escape'); await finish();
    assert.equal(await capture.evaluate(() => document.activeElement?.classList.contains('project-title')), true);

    await owner(component => component.store.openNewTask());
    await capture.waitFor(() => document.querySelector('input[aria-label="Task name"]'));
    await capture.fill('input[aria-label="Task name"]', `Reconcile events ${theme}`);
    await capture.press('Enter');
    await capture.waitFor(() => !document.querySelector('ex-new-task [role="status"]'));
    await capture.press('Enter');
    await capture.waitFor(() => !document.querySelector('ex-new-task [role="status"]'));
    await capture.press('Enter');
    await capture.waitFor(() => document.querySelector('ex-workspace-task-header h1')?.textContent.includes(`Reconcile events ${document.documentElement.dataset.theme}`));
    await finish();
    yield { name: `${theme}-created-task`, inspect: ['ex-workspace-task-header'] };
    await capture.viewport(1000, 760); await capture.reducedMotion(true); await finish();
    yield { name: `${theme}-narrow-reduced`, inspect: ['ex-app-shell'] };
    await capture.reducedMotion(false);
    await capture.viewport(1440, 960);
    await capture.click('ex-project-rail [aria-label="Add project"]');
    await capture.waitFor(() => document.querySelector('.dialog ex-new-project input[role="combobox"]'));
    await finish();
    assert.equal(await capture.evaluate(() => document.activeElement?.getAttribute('role')), 'combobox');
    yield { name: `${theme}-add-project`, inspect: ['.dialog', 'ex-new-project'] };
    await capture.waitFor(() => document.querySelector('[role="option"]'));
    await capture.press('Enter'); await capture.press('Enter');
    await finish();
    await capture.fill('input[aria-label="Project name"]', `Analytics ${theme}`);
    await capture.waitFor(() => document.querySelector('ex-new-project footer button')?.disabled === false);
    await capture.press('Enter'); await finish(); await capture.press('Enter');
    await capture.waitFor(() => document.activeElement?.matches('[data-new-task]'));
    await finish();
    assert.equal(await capture.evaluate(() => !!document.querySelector('[role="dialog"]')), false);
    yield { name: `${theme}-project-created`, inspect: ['[data-new-task]', 'ex-app-shell'] };
  }

  await capture.viewport(1200, 900);
  await capture.component('ex-connected-workspace-demo', component => component.fixture.failure());
  await capture.waitFor(() => document.querySelector('ex-machine-workspace')?.textContent.includes('Workspace unavailable'));
  yield { name: 'workspace-error', inspect: ['ex-workspace-navigation [role="alert"]', '.empty-state'] };
  await capture.component('ex-connected-workspace-demo', component => component.fixture.empty());
  await capture.waitFor(() => document.querySelector('ex-workspace-onboarding'));
  await finish();
  yield { name: 'first-project', inspect: ['ex-workspace-onboarding', '.workspace-frame'] };
  await capture.click('ex-workspace-onboarding input[role="combobox"]');
  await capture.waitFor(() => document.querySelector('[role="option"]'));
  await capture.press('Enter'); await capture.press('Enter');
  await capture.waitFor(() => document.querySelector('ex-workspace-onboarding ex-new-project footer button')?.disabled === false);
  await capture.press('Enter'); await finish(); await capture.press('Enter');
  await capture.waitFor(() => document.activeElement?.matches('[data-new-task]'));
  await finish();
  assert.equal(await capture.evaluate(() => document.querySelectorAll('ex-workspace-onboarding').length), 0);
  assert.equal(await capture.evaluate(() => !!document.querySelector('[role="dialog"]')), false);
  assert.equal(await capture.evaluate(() => !!document.querySelector('ex-new-task')), false);
  yield { name: 'first-project-created', inspect: ['ex-project-rail', '[data-new-task]', 'ex-app-shell'] };
}
