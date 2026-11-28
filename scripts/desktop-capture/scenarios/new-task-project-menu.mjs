import assert from 'node:assert/strict';

/** The header opens a portaled project menu without moving the task draft. */
export default async function* (capture) {
  await capture.evaluate(() => { if (location.pathname !== '/connected-workspace') location.href = '/connected-workspace'; });
  await capture.waitFor(() => document.querySelector('ex-workspace-navigation ex-task-list'));
  const owner = fn => capture.component('ex-machine-workspace', fn);
  const finish = async () => {
    await capture.settle();
    await capture.waitFor(() => document.getAnimations().every(animation => !Number.isFinite(animation.effect?.getComputedTiming().endTime) || animation.playState !== 'running'));
  };
  const geometry = () => capture.evaluate(() => ['.dialog', 'ex-new-task', 'ex-new-task button.project', 'input[aria-label="Task name"]'].map(selector => {
    const { x, y, width, height } = document.querySelector(selector).getBoundingClientRect();
    return { x, y, width, height };
  }));
  for (const theme of ['light', 'dark']) {
    await capture.theme(theme);
    for (const narrow of [false, true]) {
      await capture.viewport(narrow ? 390 : 1280, narrow ? 720 : 900);
      await capture.reducedMotion(narrow);
      await owner(component => component.store.openNewTask('1'));
      await capture.waitFor(() => document.activeElement?.getAttribute('aria-label') === 'Task name');
      await capture.fill('input[aria-label="Task name"]', 'Keep my draft');
      await finish();
      const before = await geometry();
      await capture.click('ex-new-task button.project');
      await capture.waitFor(() => document.querySelector('ex-dropdown-menu[aria-label="Task project"]'));
      await finish();
      assert.deepEqual(await geometry(), before, 'opening the menu must not move or resize the dialog, card, trigger or field');
      assert.equal(await capture.evaluate(() => document.querySelectorAll('.dialog ex-dropdown').length), 0);
      assert.equal(await capture.evaluate(() => document.querySelector('[role="menuitemradio"][aria-checked="true"]')?.textContent.trim()), 'Payments');
      const prefix = `${theme}-${narrow ? 'narrow-reduced' : 'wide'}`;
      yield { name: `${prefix}-project-menu`, inspect: ['.dialog', 'ex-new-task button.project', 'ex-dropdown-menu', '[role="menuitemradio"]'], metadata: { before, after: await geometry() } };
      await capture.press('Escape');
      await capture.waitFor(() => !document.querySelector('ex-dropdown-menu'));
      assert.equal(await capture.evaluate(() => document.activeElement === document.querySelector('ex-new-task button.project')), true);
      assert.equal(await capture.evaluate(() => document.querySelector('input[aria-label="Task name"]').value), 'Keep my draft');
      assert.deepEqual(await geometry(), before);
      await capture.press('ArrowDown');
      await capture.waitFor(() => document.querySelector('ex-dropdown-menu'));
      // Re-selecting the checked project dismisses without resetting the draft.
      await capture.press('Enter');
      await capture.waitFor(() => !document.querySelector('ex-dropdown-menu'));
      assert.equal(await capture.evaluate(() => document.querySelector('input[aria-label="Task name"]').value), 'Keep my draft');
      await capture.press('ArrowDown');
      await capture.waitFor(() => document.querySelector('ex-dropdown-menu'));
      await capture.press('ArrowDown'); await capture.press('Enter');
      await capture.waitFor(() => document.querySelector('ex-new-task button.project')?.textContent.includes('Storefront'));
      await finish();
      assert.equal(await owner(component => component.store.draftProject().id), 2);
      assert.equal(await capture.evaluate(() => document.querySelector('input[aria-label="Task name"]').value), '');
      yield { name: `${prefix}-project-selected`, inspect: ['.dialog', 'ex-new-task button.project'] };
      await capture.click('ex-new-task button.project');
      await capture.waitFor(() => document.querySelector('ex-dropdown-menu'));
      await owner(component => component.store.closeDialog());
      await capture.waitFor(() => !document.querySelector('ex-dropdown-menu') && !document.querySelector('.dialog'));
    }
  }
}
