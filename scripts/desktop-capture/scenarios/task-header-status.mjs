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
  const summary = (files = 0) => ({ ok: true, value: { taskId: 11, branch: 'fix/idempotent-retries', upstream: 'origin/main', ahead: 0, behind: 0, files, additions: files ? 214 : 0, deletions: files ? 38 : 0, conflicted: false } });
  const geometry = () => capture.evaluate(() => {
    const header = document.querySelector('ex-task-header header');
    const box = element => {
      const rect = element.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, height: rect.height };
    };
    return {
      header: box(header),
      rows: [...header.querySelectorAll(':scope > .row')].map(box),
      branch: box(header.querySelector('ex-branch-chip')),
      controlHeight: parseFloat(getComputedStyle(header).getPropertyValue('--control-height')),
      overflow: document.documentElement.scrollWidth > innerWidth,
    };
  });

  for (const theme of ['light', 'dark']) {
    for (const narrow of [false, true]) {
      const name = `${theme}-${narrow ? 'narrow-reduced' : 'wide'}`;
      await capture.viewport(narrow ? 1000 : 1440, 900);
      await capture.theme(theme); await capture.reducedMotion(narrow);
      await capture.evaluate(() => { location.href = '/connected-workspace'; });
      await capture.waitFor(() => document.querySelector('[data-task-id="11"]'));
      await arm();
      await owner(component => component.store.selectSession({ taskId: '11', sessionId: '101' }));
      await capture.waitFor(() => document.querySelector('ex-task-header .meta')?.textContent === 'Checking changes…');
      if (!narrow) await capture.click('ex-task-header [aria-label="Toggle side panel"]');
      await finish();
      assert.equal(await capture.evaluate(() => !!document.querySelector('ex-task-header ex-git-bar')), false);
      assert.equal(await capture.evaluate(() => document.querySelector('ex-task-header .link').disabled), true);
      const loading = await geometry();
      assert.equal(loading.overflow, false);
      assert.ok(loading.rows.every(row => row.height >= loading.controlHeight));
      yield { name: `${name}-checking`, inspect: ['ex-task-header', 'ex-task-header .row'], metadata: loading };

      await complete(summary());
      await capture.waitFor(() => document.querySelector('ex-task-header .stat.quiet')?.textContent === 'Up to date');
      await finish();
      assert.deepEqual(await geometry(), loading, 'Loading must reserve the exact settled header and branch positions');
      yield { name: `${name}-current`, inspect: ['ex-task-header', 'ex-task-header .row'], metadata: await geometry() };

      await capture.click('ex-task-header .stage');
      await capture.press('Escape'); await finish();
      assert.equal(await capture.evaluate(() => document.activeElement?.classList.contains('stage')), true);
      assert.notEqual(await capture.evaluate(() => getComputedStyle(document.activeElement).boxShadow), 'none');
      yield { name: `${name}-keyboard`, selector: 'ex-task-header', inspect: ['ex-task-header .stage'] };

      await arm();
      await capture.component('ex-workspace-task-header', component => { void component.git.refresh(); });
      await capture.waitFor(() => document.querySelector('ex-task-header .meta')?.textContent === 'Checking changes…');
      assert.deepEqual(await geometry(), loading, 'Refreshing an existing status must keep the header still');
      yield { name: `${name}-refreshing`, selector: 'ex-task-header' };
      await complete(summary(7));
      await capture.waitFor(() => document.querySelector('ex-task-header .primary')?.getAttribute('aria-label') === 'Commit 7');
      await finish();
      assert.deepEqual(await geometry(), loading, 'Changed-file actions must keep the same header geometry');
      yield { name: `${name}-changes`, selector: 'ex-task-header', metadata: await geometry() };

      await arm();
      await capture.component('ex-workspace-task-header', component => { void component.git.refresh(); });
      await complete({ ok: false, error: { code: 'transport', message: 'Git status could not be loaded.' } });
      await capture.waitFor(() => document.querySelector('ex-workspace-task-header [role="alert"]'));
      assert.deepEqual(await geometry(), loading, 'Error recovery must preserve the header geometry');
      await arm();
      await capture.click('ex-workspace-task-header .git-notice button');
      await complete(summary());
      await finish();
      assert.deepEqual(await geometry(), loading);
    }
  }
}
