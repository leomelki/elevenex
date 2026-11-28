import assert from 'node:assert/strict';

/** Production commit owner with controlled transport failures, never real repository writes. */
export default async function* (capture) {
  await capture.evaluate(() => { if (location.pathname !== '/connected-workspace') location.href = '/connected-workspace'; });
  await capture.waitFor(() => document.querySelector('ex-workspace-navigation ex-task-list'));
  const fixture = data => capture.component('ex-connected-workspace-demo', (component, input) => {
    if (input.failure !== undefined) component.fixture.setGitFailure(input.failure);
    if (input.held !== undefined) component.fixture.setGitActionHeld(input.held);
  }, data);
  const settled = async () => {
    await capture.settle();
    await capture.waitFor(() => document.getAnimations().every(a => !Number.isFinite(a.effect?.getComputedTiming().endTime) || a.playState !== 'running'));
    await capture.settle();
  };
  for (const theme of ['light', 'dark']) {
    await capture.viewport(1280, 900); await capture.theme(theme);
    await capture.component('ex-machine-workspace', c => c.store.selectSession({ taskId: '11', sessionId: '101' }));
    await capture.waitFor(() => document.querySelector('ex-git-bar .primary')?.textContent.includes('Commit'));
    await settled();
    await capture.click('ex-git-bar .primary'); await settled();
    await capture.waitFor(() => !document.querySelector('ex-commit-panel .loading'));
    await capture.fill('ex-commit-panel .message input', 'Keep my commit draft');
    await capture.click('ex-commit-panel .summary'); await settled();
    await capture.click('ex-commit-panel .file:nth-child(2) input');
    await capture.waitFor(() => !document.querySelector('ex-commit-panel .loading'));
    await fixture({ failure: 'message', held: true });
    await capture.fill('ex-commit-panel .message input', 'Keep my commit draft');
    await capture.press('Enter');
    await capture.waitFor(() => document.querySelector('ex-commit-panel [aria-busy=true]'));
    assert.equal(await capture.evaluate(() => document.querySelector('ex-commit-panel .message input').disabled), true);
    yield { name: `${theme}-committing`, inspect: ['ex-commit-panel .box', 'ex-git-bar .primary'] };
    // Selecting another conversation must neither close the panel nor clear its pending mutation.
    await capture.component('ex-machine-workspace', c => c.store.selectSession({ taskId: '11', sessionId: '102' }));
    assert.equal(await capture.evaluate(() => document.querySelector('ex-commit-panel [aria-busy=true]') !== null), true);
    await fixture({ held: false });
    await capture.waitFor(() => document.querySelector('ex-commit-panel .submission-error'));
    assert.equal(await capture.evaluate(() => document.querySelector('ex-commit-panel .message input').value), 'Keep my commit draft');
    assert.equal(await capture.evaluate(() => document.querySelector('ex-commit-panel .file:nth-child(2) input').checked), false);
    await settled();
    yield { name: `${theme}-failed-draft`, inspect: ['ex-commit-panel .box', 'ex-commit-panel .submission-error'] };
    await capture.click('ex-commit-panel .submission-error button');
    await capture.waitFor(() => !document.querySelector('ex-commit-panel .loading') && !document.querySelector('ex-commit-panel .submission-error'));
    assert.equal(await capture.evaluate(() => document.querySelector('ex-commit-panel .file:nth-child(2) input').checked), false);
    await fixture({ failure: 'unknown' });
    await capture.click('ex-commit-panel footer button[exbutton]');
    await capture.waitFor(() => document.querySelector('ex-commit-panel .submission-error')?.textContent.includes('Check the result'));
    assert.equal(await capture.evaluate(() => document.querySelector('ex-commit-panel footer button[exbutton]').disabled), true);
    await settled();
    yield { name: `${theme}-unconfirmed`, inspect: ['ex-commit-panel .box'] };
    await capture.reducedMotion(true); await capture.viewport(680, 620); await settled();
    await capture.evaluate(() => { const body = document.querySelector('ex-commit-panel .body'); body.scrollTop = body.scrollHeight; });
    await settled();
    yield { name: `${theme}-compact-recovery`, inspect: ['ex-commit-panel .box', 'ex-commit-panel .body', 'ex-commit-panel .submission-error button', 'ex-commit-panel footer'] };
    await capture.hover('ex-commit-panel .submission-error button');
    await capture.click('ex-commit-panel .submission-error button');
    await capture.waitFor(() => !document.querySelector('ex-commit-panel .submission-error'));
    await capture.click('ex-commit-panel footer button[exbutton]');
    await capture.waitFor(() => !document.querySelector('ex-commit-panel .box'));
    await capture.reducedMotion(false);
  }
}
