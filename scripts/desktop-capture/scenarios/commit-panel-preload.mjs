import assert from 'node:assert/strict';

/** A held preview proves the opening panel uses its preloaded page before revalidation. */
export default async function* (capture) {
  await capture.evaluate(() => { if (location.pathname !== '/connected-workspace') location.href = '/connected-workspace'; });
  await capture.waitFor(() => document.querySelector('ex-workspace-navigation ex-task-list'));
  await capture.component('ex-machine-workspace', component => component.store.selectSession({ taskId: '11', sessionId: '101' }));
  for (const theme of ['light', 'dark']) {
    await capture.theme(theme); await capture.viewport(1440, 960);
    await capture.waitFor(() => {
      const header = document.querySelector('ex-workspace-task-header');
      return header && window.ng.getComponent(header).git.commitPreview()?.total === 48;
    });
    await capture.component('ex-workspace-task-header', component => {
      const selected = component.store.selected();
      return component.git.readCommitPreview(selected.scopeId, { taskId: selected.taskId, query: '', includeUnstaged: true, excluded: [], includedSecrets: [] });
    });
    await capture.component('ex-workspace-task-header', component => component.bridge.setCommitPreviewHeld(true));
    try {
      // With the backend held, a ready panel proves opening reused the recent preload.
      await capture.click('ex-git-bar .primary');
      await capture.waitFor(() => document.activeElement?.matches('ex-commit-panel .message input') && !document.querySelector('ex-commit-panel .loading'));
      assert.equal(await capture.evaluate(() => document.querySelector('ex-commit-panel footer button[exbutton]').disabled), false);
      await capture.motion.finish(); await capture.settle();
      yield { name: `${theme}-recent-ready`, inspect: ['ex-commit-panel .box'] };
      await capture.press('Escape');
      await capture.waitFor(() => !document.querySelector('ex-commit-panel .commit-layer'));
      // Exercise the real five-second expiry without replacing the product clock.
      const beforeExpiry = await capture.evaluate(() => Date.now());
      await capture.waitFor(start => Date.now() - start >= 5000, beforeExpiry);
      await capture.click('ex-git-bar .primary');
      await capture.waitFor(() => document.activeElement?.matches('ex-commit-panel .message input'));
      await capture.click('ex-commit-panel .summary');
      await capture.motion.finish(); await capture.settle();
      const cached = await capture.evaluate(() => ({
        files: document.querySelectorAll('ex-commit-panel .file').length,
        checking: !!document.querySelector('ex-commit-panel .loading'),
        disabled: document.querySelector('ex-commit-panel footer button[exbutton]').disabled,
        secret: document.querySelector('ex-commit-panel .note').textContent.includes('.env.local'),
      }));
      assert.deepEqual(cached, { files: 5, checking: true, disabled: true, secret: true });
      await capture.fill('ex-commit-panel .message input', 'Keep the preloaded file list');
      yield { name: `${theme}-preloaded-checking`, inspect: ['ex-commit-panel .box'], metadata: { cached } };
      await capture.component('ex-workspace-task-header', component => component.bridge.setCommitPreviewHeld(false));
      await capture.waitFor(() => !document.querySelector('ex-commit-panel .loading'));
      assert.equal(await capture.evaluate(() => document.querySelector('ex-commit-panel .message input').value), 'Keep the preloaded file list');
      assert.equal(await capture.evaluate(() => document.querySelector('ex-commit-panel footer button[exbutton]').disabled), false);
      yield { name: `${theme}-revalidated`, inspect: ['ex-commit-panel .box'] };
      await capture.press('Escape');
      await capture.waitFor(() => !document.querySelector('ex-commit-panel .commit-layer'));
      assert.equal(await capture.evaluate(() => document.activeElement?.matches('ex-git-bar .primary')), true);
      await capture.reducedMotion(true); await capture.viewport(1040, 760);
      await capture.click('ex-git-bar .primary');
      await capture.waitFor(() => document.activeElement?.matches('ex-commit-panel .message input') && !document.querySelector('ex-commit-panel .loading'));
      await capture.motion.finish(); await capture.settle();
      yield { name: `${theme}-narrow-reduced`, inspect: ['ex-commit-panel .box'] };
      await capture.press('Escape');
      await capture.waitFor(() => !document.querySelector('ex-commit-panel .commit-layer'));
      await capture.reducedMotion(false);
    } finally {
      await capture.component('ex-workspace-task-header', component => component.bridge.setCommitPreviewHeld(false));
    }
  }
}
