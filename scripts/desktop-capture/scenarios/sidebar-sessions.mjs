import assert from 'node:assert/strict';

/** Real task tree + production archive/Undo owner, with an isolated backend. */
export default async function* (capture) {
  await capture.evaluate(() => { location.href = '/connected-workspace'; });
  await capture.waitFor(() => document.querySelector('ex-workspace-navigation ex-task-list'));
  const owner = (fn, data) => capture.component('ex-machine-workspace', fn, data);
  const finish = async () => {
    await capture.settle();
    await capture.waitFor(() => document.getAnimations().every(a => !Number.isFinite(a.effect?.getComputedTiming().endTime) || a.playState !== 'running'));
    await capture.settle();
  };
  const visibleIds = () => capture.evaluate(() => [...document.querySelectorAll('[data-task-id="11"] ex-session-row .row')].filter(row => !row.closest('[inert]')).map(row => row.dataset.sessionId));
  const inspect = ['[data-task-id="11"]', '[data-task-id="11"] .earlier', '[data-task-id="11"] .archive', 'ex-toast'];
  for (const theme of ['light','dark']) {
    await capture.theme(theme); await capture.viewport(1440,900); await capture.reducedMotion(false);
    await capture.component('ex-connected-workspace-demo', component => component.fixture.busyTask());
    await owner(component => component.store.selectProject('1')); await finish();
    assert.equal((await visibleIds()).length,7);
    assert.equal(await capture.evaluate(() => document.querySelector('[data-task-id="11"] .earlier-more').textContent.includes('12 older')),true);
    yield {name:`${theme}-capped`,inspect};
    await capture.click('[data-task-id="11"] .earlier-more');
    const opening = await capture.measureMotion(['[data-task-id="11"] [data-session-id="214"] .select'],780);
    await finish();
    yield {name:`${theme}-revealed-batch`,inspect,metadata:{opening}};
    assert.equal((await visibleIds()).length,12);
    await capture.click('[data-task-id="11"] .earlier-more'); await finish(); assert.equal((await visibleIds()).length,17);
    await capture.click('[data-task-id="11"] .earlier-more'); await finish(); assert.equal((await visibleIds()).length,19);
    yield {name:`${theme}-all-earlier`,inspect};
    await capture.click('[data-task-id="11"] .earlier-fewer');
    const closing = await capture.measureMotion(['[data-task-id="11"] [data-session-id="214"] .select'],780);
    await finish(); assert.equal((await visibleIds()).length,7);
    assert.equal(await capture.evaluate(() => document.activeElement?.classList.contains('earlier-more')),true);
    yield {name:`${theme}-fewer`,inspect,metadata:{closing}};
    const running = '[data-task-id="11"] [data-session-id="214"]';
    await capture.click(`${running} .select`); await capture.hover(`${running} .select`); await finish();
    yield {name:`${theme}-archive-hover`,inspect};
    await capture.click(`${running} .archive`); await finish();
    assert.equal(await capture.evaluate(selector => document.querySelector(selector).getAttribute('aria-label').includes('press again'),`${running} .archive`),true);
    await capture.hover('ex-workspace-navigation h1'); await finish();
    yield {name:`${theme}-stop-confirm`,inspect};
    await capture.press('Escape'); await finish();
    assert.equal(await capture.evaluate(selector => document.querySelector(selector).getAttribute('aria-label').includes('press again'),`${running} .archive`),false);
    await capture.click(`${running} .archive`); await capture.press('Tab'); await finish();
    assert.equal(await capture.evaluate(selector => document.querySelector(selector).getAttribute('aria-label').includes('press again'),`${running} .archive`),false);
    await capture.click(`${running} .archive`); await capture.press('Enter'); await finish();
    assert.equal((await visibleIds()).includes('214'),false);
    assert.equal(await owner(component => component.store.selected()?.sessionId),215);
    await capture.waitFor(() => document.querySelector('ex-toast'));
    assert.equal(await capture.evaluate(() => document.activeElement?.closest('[data-session-id]')?.dataset.sessionId), '215');
    yield {name:`${theme}-archived-selected`,inspect};
    await capture.click('ex-toast button[exbutton]'); await finish();
    assert.equal(await capture.evaluate(() => !!document.querySelector('[data-task-id="11"] [data-session-id="214"]')),true);
    assert.equal((await visibleIds()).includes('214'),true);
    assert.equal(await capture.evaluate(() => document.querySelector('[data-task-id="11"]').textContent.includes('finished')),false);
    yield {name:`${theme}-restored-normal`,inspect};
    await owner(component => component.store.filter.set('running')); await finish();
    assert.equal(await capture.evaluate(() => !!document.querySelector('[data-task-id="11"] .earlier-more')?.closest('ex-fold[aria-hidden="false"]')),false);
    yield {name:`${theme}-filtered`,inspect};
    await owner(component => component.store.filter.set(null)); await finish();
    // Nonrunning sessions archive immediately.
    await capture.hover('[data-task-id="11"] [data-session-id="218"] .select'); await finish();
    await capture.click('[data-task-id="11"] [data-session-id="218"] .archive'); await finish();
    assert.equal((await visibleIds()).includes('218'),false);
    await capture.click('ex-toast button[exbutton]'); await finish();
    await owner(component => component.store.openSettings()); await finish();
    await capture.click('.sheet .nav-item:last-child'); await finish();
    await capture.click('button[aria-label^="Sessions per task:"]');
    await capture.waitFor(() => document.querySelector('[role="menu"]'));
    await capture.press('End'); await capture.press('Enter'); await finish();
    yield {name:`${theme}-setting`,inspect:['.sheet']};
    await owner(component => component.store.closeDialog()); await finish();
    assert.equal((await visibleIds()).length,19); // Undo restores both stopped conversations as normal sessions.
    // Return to the default for the next theme; storage event follows the same user preference owner.
    await capture.evaluate(() => { window.localStorage.setItem('elevenex.sidebar.session-cap','5'); window.dispatchEvent(new window.StorageEvent('storage',{key:'elevenex.sidebar.session-cap'})); });
    await capture.viewport(1000,760); await capture.reducedMotion(true); await finish();
    await capture.click('[data-task-id="11"] .earlier-more'); await capture.click('[data-task-id="11"] .earlier-fewer'); await finish();
    assert.equal((await visibleIds()).length,7);
    yield {name:`${theme}-narrow-reduced`,inspect};
    await capture.reducedMotion(false);
    await capture.click('[data-task-id="11"] .earlier-more');
    await capture.click('[data-task-id="11"] .earlier-fewer');
    const interruption = await capture.measureMotion(['[data-task-id="11"]'],780);
    await finish(); assert.equal((await visibleIds()).length,7);
    yield {name:`${theme}-interrupted-reveal`,inspect,metadata:{interruption}};
    const shortcut = 'ex-task-list ex-session-row:has(.with-context) [data-session-id="200"]';
    await capture.hover(`${shortcut} .select`); await finish();
    await capture.click(`${shortcut} .archive`); await finish();
    assert.equal((await visibleIds()).includes('200'),false);
    yield {name:`${theme}-archived-attention-shortcut`,inspect};
    await capture.click('ex-toast button[exbutton]'); await finish();
  }
}
