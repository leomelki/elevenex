import assert from 'node:assert/strict';

/** Recreate the actual workspace owner against the preview's saved backend context. */
export default async function* (capture) {
  await capture.evaluate(() => { location.href = '/connected-workspace'; });
  const owner = (fn, data) => capture.component('ex-machine-workspace', fn, data);
  const finish = async () => {
    await capture.settle();
    await capture.waitFor(() => document.getAnimations().every(animation => !Number.isFinite(animation.effect?.getComputedTiming().endTime) || animation.playState !== 'running'));
    await capture.settle();
  };
  const ready = () => capture.waitFor(() => {
    const element = document.querySelector('ex-machine-workspace');
    const store = element && window.ng.getComponent(element).store;
    return store?.scopeId() && !store.loading() && !store.restoring();
  });
  const reopen = async () => {
    await capture.component('ex-connected-workspace-demo', component => component.workspaceVisible.set(false));
    await capture.waitFor(() => !document.querySelector('ex-machine-workspace'));
    await capture.component('ex-connected-workspace-demo', component => component.workspaceVisible.set(true));
    await ready();
    await finish();
  };
  await ready();
  for (const theme of ['light', 'dark']) {
    await capture.viewport(1440, 960); await capture.theme(theme);
    await owner(component => component.store.selectProject('1'));
    await owner(component => component.store.selectSession({ taskId: '11', sessionId: '102' }));
    await owner(component => { component.panel.set('browser'); component.panelOpen.set(true); component.wideReview.set(false); });
    await reopen();
    assert.deepEqual(await owner(component => [component.store.activeProject(), component.store.selected()?.sessionId, component.panel(), component.panelOpen()]), ['1', 102, 'browser', true]);
    await capture.waitFor(() => document.querySelector('ex-workspace-panels [role="tab"][aria-label="Browser"]')?.getAttribute('aria-selected') === 'true');
    yield { name: `${theme}-resumed-browser`, inspect: ['ex-workspace-task-header', 'ex-app-shell .panel', 'ex-workspace-panels [role="tab"]'] };
    await capture.click('ex-workspace-panels [role="tab"][aria-label="Changes"]');
    await capture.click('ex-workspace-panels [aria-label="Expand side panel"]');
    await reopen();
    assert.equal(await owner(component => component.wideReview()), true);
    assert.equal(await capture.evaluate(() => document.querySelector('ex-app-shell main').hasAttribute('inert')), true);
    yield { name: `${theme}-resumed-wide`, inspect: ['ex-app-shell .main', 'ex-app-shell .panel'] };
    await capture.press('Escape');
    await capture.waitFor(() => !document.querySelector('ex-app-shell main').hasAttribute('inert'));
    await capture.click('ex-workspace-panels [aria-label="Close side panel"]');
    await reopen();
    assert.equal(await owner(component => component.panelOpen()), false);
    assert.equal(await owner(component => component.wideReview()), false);
    assert.equal(await capture.evaluate(() => document.querySelector('ex-app-shell .panel').hasAttribute('inert')), true);
    await capture.viewport(1000, 760); await capture.reducedMotion(true);
    await finish();
    yield { name: `${theme}-resumed-closed-narrow`, inspect: ['ex-app-shell', 'ex-workspace-task-header', 'ex-app-shell .panel'] };
    await capture.reducedMotion(false);
  }
}
