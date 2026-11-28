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
  const summary = (files = 0, behind = 0) => ({ ok: true, value: { taskId: 11, branch: 'fix/idempotent-retries', upstream: 'origin/main', ahead: 0, behind, files, additions: files ? 214 : 0, deletions: files ? 38 : 0, conflicted: false } });
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
      close: box(row.querySelector('.close-task')),
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
      await arm();
      await owner(component => component.store.selectSession({ taskId: '11', sessionId: '101' }));
      await capture.waitFor(() => document.querySelector('ex-task-header .git-loading')?.textContent === 'Checking Git status…');
      if (narrow) await capture.click('ex-task-header [aria-label="Toggle side panel"]');
      await finish();
      assert.equal(await capture.evaluate(() => !!document.querySelector('ex-task-header ex-git-bar')), false);
      assert.equal(await capture.evaluate(() => !!document.querySelector('ex-task-header .link')), false);
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

      await capture.click('ex-task-header .stage');
      await capture.press('Escape'); await finish();
      assert.equal(await capture.evaluate(() => document.activeElement?.classList.contains('stage')), true);
      assert.notEqual(await capture.evaluate(() => getComputedStyle(document.activeElement).boxShadow), 'none');
      yield { name: `${name}-keyboard`, selector: 'ex-task-header', inspect: ['ex-task-header .stage'] };
      await capture.press('Escape');

      await arm();
      await capture.component('ex-workspace-task-header', component => { void component.git.refresh(); });
      await capture.waitFor(() => !!document.querySelector('ex-task-header .stat.quiet'));
      assert.deepEqual(await geometry(), loading, 'Refreshing an existing status must keep the header still');
      yield { name: `${name}-refreshing`, selector: 'ex-task-header' };
      await complete(summary(7, narrow ? 3 : 0));
      await capture.waitFor(() => document.querySelector('ex-task-header .primary')?.getAttribute('aria-label') === 'Commit 7');
      await finish();
      assert.deepEqual(await geometry(), loading, 'Changed-file actions must keep the same header geometry');
      const controls = await capture.evaluate(() => {
        const header = document.querySelector('ex-task-header');
        const branch = header.querySelector('ex-branch-chip .name').getBoundingClientRect();
        const title = header.querySelector('h1').getBoundingClientRect();
        const count = header.querySelector('.primary .count').getBoundingClientRect();
        const pull = header.querySelector('button.pull')?.getBoundingClientRect();
        const review = header.querySelector('.stat-slot button').getBoundingClientRect();
        return {
          titleAndBranchFit: title.width > 0 && branch.left >= title.right && branch.width >= 12,
          commitCountVisible: count.width > 0,
          pullFits: !!pull && pull.right <= review.left,
        };
      });
      assert.deepEqual(controls, { titleAndBranchFit: true, commitCountVisible: true, pullFits: narrow });
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
