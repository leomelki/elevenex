import assert from 'node:assert/strict';

/** Real task-screen components and their production owner, with preview-only backend data. */
export default async function* (capture) {
  await capture.evaluate(() => { if (location.pathname !== '/connected-workspace') location.href = '/connected-workspace'; });
  await capture.waitFor(() => document.querySelector('ex-workspace-navigation ex-task-list'));
  const owner = fn => capture.component('ex-machine-workspace', fn);
  const finish = async () => {
    await capture.settle();
    await capture.waitFor(() => document.getAnimations().every(animation => !Number.isFinite(animation.effect?.getComputedTiming().endTime) || animation.playState !== 'running'));
    await capture.settle();
  };
  for (const theme of ['light', 'dark']) {
    await capture.viewport(1440, 960); await capture.theme(theme);
    await owner(component => component.store.selectSession({ taskId: '11', sessionId: '101' }));
    await finish();
    assert.equal(await capture.evaluate(() => document.querySelectorAll('article.current .new-session, article.current .empty-session').length), 0);
    assert.equal(await capture.evaluate(() => document.querySelector('ex-task-header .close-task')?.textContent.includes('Close task')), true);
    yield {name: `${theme}-task`, inspect: ['ex-task-header', 'article.current .add']};
    await capture.motion.freeze();
    await capture.click('ex-git-bar .primary');
    await capture.waitFor(() => document.querySelector('ex-commit-panel .box') && getComputedStyle(document.querySelector('ex-commit-panel .box')).visibility === 'visible');
    await capture.evaluate(() => {
      for (const animation of document.querySelector('ex-commit-panel .commit-layer').getAnimations({ subtree: true })) {
        if (Number.isFinite(animation.effect?.getComputedTiming().endTime)) animation.currentTime = 180;
      }
    });
    await capture.settle();
    assert.notEqual(await capture.evaluate(() => getComputedStyle(document.querySelector('ex-commit-panel .box')).transform), 'none');
    yield {name: `${theme}-opening`, inspect: ['ex-commit-panel .box', 'ex-git-bar .primary']};
    await capture.motion.finish(); await capture.motion.play();
    await capture.waitFor(() => document.activeElement?.matches('ex-commit-panel .message input') && !document.querySelector('ex-commit-panel .loading'));
    assert.equal(await capture.evaluate(() => document.querySelector('ex-commit-panel .summary')?.getAttribute('aria-expanded')), 'false');
    yield {name: `${theme}-commit`, inspect: ['ex-commit-panel .box', 'ex-commit-panel .message input']};
    await capture.click('ex-commit-panel .summary'); await finish();
    assert.equal(await capture.evaluate(() => document.querySelectorAll('ex-commit-panel .file').length), 5);
    assert.equal(await capture.evaluate(() => document.querySelector('ex-commit-panel .file input')?.checked), false);
    yield {name: `${theme}-files`, inspect: ['ex-commit-panel .box', 'ex-commit-panel .scroll']};
    await capture.click('ex-commit-panel .show'); await finish();
    assert.ok(await capture.evaluate(() => document.querySelector('ex-commit-panel .scroll').getBoundingClientRect().height <= 168));
    await capture.fill('ex-commit-panel .filter input', 'test-47');
    await capture.waitFor(() => !document.querySelector('ex-commit-panel .loading') && document.querySelectorAll('ex-commit-panel .file').length === 1);
    yield {name: `${theme}-filter`, inspect: ['ex-commit-panel .file-list']};
    await capture.fill('ex-commit-panel .filter input', '');
    await capture.waitFor(() => !document.querySelector('ex-commit-panel .loading'));
    await capture.click('ex-commit-panel .option input');
    await capture.waitFor(() => !document.querySelector('ex-commit-panel .loading') && document.querySelector('ex-commit-panel footer button[exbutton]')?.textContent.includes('14'));
    yield {name: `${theme}-staged`, inspect: ['ex-commit-panel .box']};
    await capture.press('Escape'); await finish();
    assert.equal(await capture.evaluate(() => document.activeElement?.matches('ex-git-bar .primary')), true);
    await capture.click('ex-git-bar .primary'); await finish();
    await capture.waitFor(() => !document.querySelector('ex-commit-panel .loading'));
    await capture.click('ex-commit-panel .note .inline');
    await capture.waitFor(() => !document.querySelector('ex-commit-panel .loading') && document.querySelector('ex-commit-panel .note')?.textContent.includes('Leave it out'));
    yield {name: `${theme}-secrets-included`, inspect: ['ex-commit-panel .box']};
    // Outside and the same trigger both close without submitting.
    await capture.click('ex-task-header .close-task'); await finish();
    await capture.waitFor(() => document.querySelector('[role="dialog"][aria-label="Close task"]'));
    await capture.press('Escape'); await finish();
    await capture.click('ex-git-bar .primary'); await finish();
    await capture.waitFor(() => !document.querySelector('ex-commit-panel .loading'));
    await capture.fill('ex-commit-panel .message input', 'Keep this draft during a reversal');
    await capture.motion.freeze(); await capture.click('ex-git-bar .primary');
    await capture.evaluate(() => { for (const animation of document.querySelector('ex-commit-panel .commit-layer').getAnimations({subtree:true})) if (Number.isFinite(animation.effect?.getComputedTiming().endTime)) animation.currentTime = 220; });
    yield {name: theme + '-closing', inspect: ['ex-commit-panel .box']};
    await capture.click('ex-git-bar .primary');
    assert.equal(await capture.evaluate(() => document.querySelector('ex-commit-panel .message input').value), 'Keep this draft during a reversal');
    await capture.motion.finish(); await capture.motion.play(); await finish();
    await capture.press('Escape'); await finish();
    assert.equal(await capture.evaluate(() => document.querySelector('ex-commit-panel .box') === null), true);
    await capture.reducedMotion(true); await capture.viewport(1040, 760);
    await capture.click('ex-git-bar .primary'); await finish();
    await capture.waitFor(() => !document.querySelector('ex-commit-panel .loading'));
    yield {name: `${theme}-narrow-reduced`, inspect: ['ex-commit-panel .box', 'ex-task-header']};
    await capture.press('Escape'); await finish(); await capture.reducedMotion(false);
  }
  await capture.viewport(1440, 960);
  await capture.click('ex-git-bar .primary'); await finish();
  await capture.waitFor(() => document.activeElement?.matches('ex-commit-panel .message input') && !document.querySelector('ex-commit-panel .loading'));
  await capture.press('Enter'); await finish();
  await capture.waitFor(() => document.querySelector('ex-git-bar .primary')?.getAttribute('aria-label') === 'Commit 1');
  yield {name: 'committed-with-file-left-out', inspect: ['ex-git-bar']};
  await capture.press('n', 5);
  await capture.waitFor(() => document.querySelector('ex-session-row [aria-current="true"]')?.textContent.includes('Explore the task'));
  yield {name: 'new-session-shortcut', inspect: ['article.current']};
}
