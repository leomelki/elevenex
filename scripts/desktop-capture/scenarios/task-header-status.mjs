import assert from 'node:assert/strict';

/** Real connected header with a controlled promise at the preview backend boundary. */
export default async function* (capture) {
  const owner = (fn, data) => capture.component('ex-machine-workspace', fn, data);
  const finish = async () => {
    await capture.settle();
    await capture.waitFor(() => document.getAnimations().every(animation => !Number.isFinite(animation.effect?.getComputedTiming().endTime) || animation.playState !== 'running'));
  };
  const arm = () => capture.component('ex-connected-workspace-demo', component => {
    let complete;
    const reply = new Promise(resolve => { complete = resolve; });
    // This replacement exists only in the isolated preview provider, never the bridge.
    component.fixture.workspaceGit = Object.assign(() => reply, { complete });
  });
  const complete = result => capture.component('ex-connected-workspace-demo', (component, result) => component.fixture.workspaceGit.complete(result), result);
  const summary = (files = 0, behind = 0, upstream = 'origin/main') => ({ ok: true, value: { taskId: 11, branch: 'fix/idempotent-retries', upstream, ahead: 0, behind, files, additions: files ? 214 : 0, deletions: files ? 38 : 0, conflicted: false } });
  const menuTrigger = 'ex-task-header [aria-label="Task actions"]';
  const menu = '[role="menu"][aria-label="Task actions"]';
  const geometry = () => capture.evaluate(() => {
    const header = document.querySelector('ex-task-header header');
    const row = header.querySelector('.row');
    const box = element => {
      const rect = element.getBoundingClientRect();
      return { top: rect.top, left: rect.left, right: rect.right, height: rect.height };
    };
    return {
      header: box(header),
      row: box(row),
      rowCount: header.querySelectorAll(':scope > .row').length,
      titleStart: box(row.querySelector('h1')).left,
      panel: box(row.querySelector('[aria-label="Toggle side panel"]')),
      overflow: row.scrollWidth > row.clientWidth || document.documentElement.scrollWidth > innerWidth,
    };
  });

  for (const theme of ['light', 'dark']) {
    for (const narrow of [false, true]) {
      const name = `${theme}-${narrow ? 'narrow-reduced' : 'wide'}`;
      await capture.viewport(narrow ? 880 : 1440, 900);
      await capture.theme(theme); await capture.reducedMotion(narrow);
      await capture.evaluate(() => { location.href = '/connected-workspace'; });
      await capture.waitFor(() => document.querySelector('[data-task-id="11"]'));
      await capture.component('ex-connected-workspace-demo', component => component.fixture.liveSessionStatus(101, 'done'));
      await arm();
      await owner(component => component.store.selectSession({ taskId: '11', sessionId: '101' }));
      await capture.waitFor(() => document.querySelector('ex-task-header .git-loading')?.textContent === 'Checking Git status…');
      if (narrow) await capture.click('ex-task-header [aria-label="Toggle side panel"]');
      await finish();
      assert.equal(await capture.evaluate(() => !!document.querySelector('ex-task-header ex-git-bar')), false);
      assert.equal(await capture.evaluate(() => !!document.querySelector('ex-task-header .link')), false);
      assert.equal(await capture.evaluate(() => !!document.querySelector('ex-task-header ex-task-stage')), false);
      const loading = await geometry();
      assert.equal(loading.overflow, false);
      assert.equal(loading.header.height, narrow ? 69 : 48);
      assert.equal(loading.rowCount, 1);
      yield { name: `${name}-checking`, inspect: ['ex-task-header', 'ex-task-header .row'], metadata: loading };

      await complete(summary());
      await capture.waitFor(() => document.querySelector('ex-task-header .stat.quiet')?.textContent === 'Up to date');
      await finish();
      assert.deepEqual(await geometry(), loading, 'Git status must preserve the toolbar, title start, and trailing controls');
      yield { name: `${name}-current`, inspect: ['ex-task-header', 'ex-task-header .row'], metadata: await geometry() };

      await capture.evaluate(selector => document.querySelector(selector).focus(), menuTrigger);
      await capture.press('ArrowDown'); await finish();
      assert.equal(await capture.evaluate(() => document.activeElement?.textContent.trim()), 'Rename branch');
      await capture.press('ArrowDown');
      assert.equal(await capture.evaluate(() => document.activeElement?.textContent.trim()), 'Copy branch name');
      await capture.press('ArrowDown');
      assert.equal(await capture.evaluate(() => document.activeElement?.textContent.trim()), 'Close task');
      assert.notEqual(await capture.evaluate(() => getComputedStyle(document.activeElement).boxShadow), 'none');
      yield { name: `${name}-task-menu`, inspect: ['ex-task-header', menu, menu + ' [role="menuitem"]'] };
      await capture.press('Escape'); await finish();
      assert.equal(await capture.evaluate(selector => document.activeElement?.matches(selector), menuTrigger), true);
      await capture.press('ArrowDown');
      await capture.press('Enter'); await finish();
      await capture.waitFor(() => document.activeElement?.matches('[aria-label="Branch name"]'));
      await capture.press('Escape'); await finish();
      assert.equal(await capture.evaluate(selector => document.activeElement?.matches(selector), menuTrigger), true);
      await capture.press('Tab');
      assert.equal(await capture.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Toggle side panel');

      await arm();
      await capture.component('ex-workspace-task-header', component => { void component.git.refresh(); });
      await complete(summary(0, 0, 'origin/fix/idempotent-retries'));
      await capture.waitFor(() => document.querySelector('ex-task-header .close-task')?.textContent.trim() === 'Close task');
      await finish();
      assert.deepEqual(await geometry(), loading, 'The labeled shortcut must preserve the header and panel position');
      yield { name: `${name}-close-shortcut`, selector: 'ex-task-header', inspect: ['ex-task-header .close-task'] };

      await arm();
      await capture.component('ex-workspace-task-header', component => { void component.git.refresh(); });
      await capture.waitFor(() => !!document.querySelector('ex-task-header .close-task'));
      assert.deepEqual(await geometry(), loading, 'Refreshing an existing status must keep the header still');
      yield { name: `${name}-refreshing`, selector: 'ex-task-header' };
      await complete(summary(7, narrow ? 3 : 0));
      await capture.waitFor(() => document.querySelector('ex-task-header .primary')?.getAttribute('aria-label') === 'Commit 7');
      await finish();
      assert.deepEqual(await geometry(), loading, 'Changed-file actions must keep the same header geometry');
      const controls = await capture.evaluate(() => {
        const header = document.querySelector('ex-task-header');
        const branch = header.querySelector('.branch').getBoundingClientRect();
        const menu = header.querySelector('.task-menu').getBoundingClientRect();
        const title = header.querySelector('h1').getBoundingClientRect();
        const count = header.querySelector('.primary .count').getBoundingClientRect();
        const pull = header.querySelector('button.pull')?.getBoundingClientRect();
        const review = header.querySelector('.stat-slot button').getBoundingClientRect();
        return {
          identityFits: title.width > 0 && branch.left >= title.right && branch.width >= 12 && menu.left >= branch.right,
          commitCountVisible: count.width > 0,
          pullFits: !!pull && pull.right <= review.left,
        };
      });
      assert.deepEqual(controls, { identityFits: true, commitCountVisible: true, pullFits: narrow });
      yield { name: `${name}-changes`, selector: 'ex-task-header', metadata: await geometry() };

      await arm();
      await capture.component('ex-workspace-task-header', component => { void component.git.refresh(); });
      await complete({ ok: false, error: { code: 'transport', message: 'Git status could not be loaded.' } });
      await capture.waitFor(() => document.querySelector('ex-workspace-task-header [role="alert"]'));
      assert.deepEqual(await geometry(), loading, 'Error recovery must preserve the header geometry');
      await arm();
      await capture.click('ex-workspace-task-header [aria-label="Refresh Git status"]');
      await complete(summary());
      await finish();
      assert.deepEqual(await geometry(), loading);
    }
  }
}
