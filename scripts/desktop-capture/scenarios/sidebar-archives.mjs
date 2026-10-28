import assert from 'node:assert/strict';

/** Persisted archive browsing and restoration through the real workspace owner. */
export default async function* (capture) {
  await capture.evaluate(() => { location.href = '/connected-workspace'; });
  await capture.waitFor(() => document.querySelector('ex-workspace-navigation ex-task-list'));
  const owner = (fn, data) => capture.component('ex-machine-workspace', fn, data);
  const finish = async () => {
    await capture.waitFor(() => document.getAnimations().every(animation => !Number.isFinite(animation.effect?.getComputedTiming().endTime) || animation.playState !== 'running'));
    await capture.settle();
  };
  const normal = '[data-task-id="11"] .tree > ex-fold [data-session-id="102"]';
  const archived = '[data-task-id="11"] ex-archived-sessions [data-session-id="102"]';
  const toggle = '[data-task-id="11"] ex-archived-sessions > .toggle';
  const inspect = ['[data-task-id="11"]', 'ex-archived-sessions', 'ex-archived-sessions .select', 'ex-toast'];
  await owner(component => component.store.selectProject('1')); await finish();
  for (const theme of ['light', 'dark']) {
    await capture.theme(theme); await capture.viewport(1440,900); await capture.reducedMotion(false);
    assert.equal(await capture.evaluate(() => !!document.querySelector('[data-task-id="11"] ex-archived-sessions')), false);
    yield {name:`${theme}-no-archives`, inspect};
    await capture.click(`${normal} .select`); await capture.hover(`${normal} .select`);
    await capture.click(`${normal} .archive`); await finish();
    await capture.waitFor(() => document.querySelector('ex-toast'));
    await capture.click('ex-toast button[aria-label="Dismiss notification"]'); await finish();
    if (!(await capture.evaluate(selector => document.querySelector(selector).getAttribute('aria-expanded') === 'true', toggle))) await capture.click(toggle);
    await capture.waitFor(selector => !!document.querySelector(selector) && !document.querySelector(selector).closest('[inert]'), archived); await finish();
    assert.equal(await owner(component => component.store.tasks().find(task => task.id === '11').sessions.some(session => session.id === '102')), false);
    yield {name:`${theme}-archived`, inspect};
    await owner(component => component.store.refresh()); await finish();
    await capture.click(`${archived} .select`); await finish();
    assert.equal(await owner(component => component.store.selectedSession()?.status), 'archived');
    await owner(component => component.store.refresh()); await finish();
    assert.equal(await owner(component => component.store.tasks().find(task => task.id === '11').sessions.some(session => session.id === '102')), false);
    yield {name:`${theme}-history-after-refresh`, inspect};
    await capture.hover(`${archived} .select`); await capture.click(`${archived} .restore`); await finish();
    await capture.waitFor(selector => !!document.querySelector(selector) && !document.querySelector(selector).closest('[inert]'), normal);
    await capture.waitFor(() => document.activeElement?.closest('[data-session-id]')?.dataset.sessionId === '102');
    assert.equal(await owner(component => component.store.selectedSession()?.status), 'stopped');
    assert.equal(await capture.evaluate(() => document.querySelector('[data-task-id="11"]').textContent.includes('finished')), false);
    yield {name:`${theme}-restored-normal`, inspect};
    await capture.viewport(1000,760); await capture.reducedMotion(true); await finish();
    assert.equal(await capture.evaluate(() => !!document.querySelector('[data-task-id="11"] ex-archived-sessions')), false);
    yield {name:`${theme}-narrow-no-archives`, inspect};
  }
  await capture.component('ex-connected-workspace-demo', component => component.fixture.archivedHistory());
  await owner(component => component.store.refresh()); await finish();
  await capture.click(toggle); await finish();
  assert.equal(await owner(component => component.store.tasks().find(task => task.id === '11').archive.sessions.length), 20);
  const pageButton = async text => capture.evaluate(text => [...document.querySelectorAll('[data-task-id="11"] ex-archived-sessions button')].find(button => button.textContent.includes(text))?.textContent, text);
  assert.ok(await pageButton('Earlier archived sessions'));
  await capture.evaluate(() => document.querySelector('[data-task-id="11"] ex-archived-sessions button[exbutton]').scrollIntoView({block:'center'}));
  await capture.click('[data-task-id="11"] ex-archived-sessions button[exbutton]'); await finish();
  assert.equal(await owner(component => component.store.tasks().find(task => task.id === '11').archive.sessions[0].id), '305');
  assert.equal(await owner(component => component.store.tasks().find(task => task.id === '11').sessions.length), 2);
  yield {name:'dark-earlier-archive-page', inspect};
  await capture.theme('light'); await capture.viewport(1440,900); await capture.reducedMotion(false); await finish();
  yield {name:'light-earlier-archive-page', inspect};
}
