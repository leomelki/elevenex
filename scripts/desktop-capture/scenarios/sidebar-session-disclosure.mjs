import assert from 'node:assert/strict';

/** Disclosure belongs to task identity, across mutations and project-view remounts. */
export default async function* (capture) {
  await capture.evaluate(() => { location.href = '/connected-workspace'; });
  await capture.waitFor(() => document.querySelector('ex-workspace-navigation ex-task-list'));
  const owner = (fn, data) => capture.component('ex-machine-workspace', fn, data);
  const finish = async () => {
    await capture.settle();
    await capture.waitFor(() => document.getAnimations().every(a => !Number.isFinite(a.effect?.getComputedTiming().endTime) || a.playState !== 'running'));
    await capture.settle();
  };
  const visible = () => capture.evaluate(() => [...document.querySelectorAll('[data-task-id="11"] ex-session-row .row')].filter(row => !row.closest('[inert]')).map(row => row.dataset.sessionId));
  const inspect = ['ex-workspace-navigation','[data-task-id="11"]','.earlier'];
  for (const [theme,reduced] of [['light',false],['dark',true]]) {
    await capture.theme(theme); await capture.reducedMotion(reduced); await capture.viewport(1440,900);
    await capture.component('ex-connected-workspace-demo', component => component.fixture.busyTask());
    await owner(async component => { component.store.sessionDisclosures.set(new Map()); await component.store.selectProject('2'); await component.store.selectProject('1'); }); await finish();
    await capture.click('[data-task-id="11"] .earlier-more'); await finish();
    const revealed = await visible(); assert.equal(revealed.length,12);
    // Neither direction may reset disclosures, even with no selected task retained.
    await owner(component => component.store.selectProject('all')); await finish();
    assert.deepEqual(await visible(),revealed);
    yield {name:`${theme}-all-projects-retained`,inspect};
    await owner(component => component.store.selectProject('1')); await finish();
    assert.deepEqual(await visible(),revealed);
    yield {name:`${theme}-specific-project-retained`,inspect};
    await capture.hover('[data-task-id="11"] [data-session-id="218"] .select'); await finish();
    await capture.click('[data-task-id="11"] [data-session-id="218"] .archive'); await finish();
    const survivors = revealed.filter(id => id !== '218'); assert.deepEqual(await visible(),survivors);
    yield {name:`${theme}-archive-retained`,inspect};
    await capture.click('[data-task-id="11"] header button[aria-label="New session in this task"]'); await finish();
    const created = await owner(component => String(component.store.selected().sessionId));
    assert.deepEqual(await visible(),[...survivors,created]);
    await owner(component => component.store.refresh()); await finish();
    assert.deepEqual(await visible(),[...survivors,created]);
    yield {name:`${theme}-create-and-refresh-retained`,inspect};
    // Expanded state also survives selected-task retention in both directions.
    await owner(component => component.store.selectProject('all')); await finish();
    await owner(component => component.store.selectProject('1')); await finish();
    assert.deepEqual(await visible(),[...survivors,created]);
    while (await capture.evaluate(() => !!document.querySelector('[data-task-id="11"] .earlier-more'))) {
      await capture.click('[data-task-id="11"] .earlier-more'); await finish();
    }
    assert.equal((await visible()).length,19);
    await capture.click('[data-task-id="11"] header button[aria-label="New session in this task"]'); await finish();
    assert.equal((await visible()).length,20);
    assert.equal(await capture.evaluate(() => !!document.querySelector('[data-task-id="11"] .earlier-more')),false);
    yield {name:`${theme}-fully-expanded-create-retained`,inspect};
    await capture.hover('[data-task-id="11"] [data-session-id="200"] .select'); await finish();
    await capture.click('[data-task-id="11"] [data-session-id="200"] .archive'); await finish();
    assert.equal((await visible()).length,19);
    assert.equal(await capture.evaluate(() => !!document.querySelector('[data-task-id="11"] .earlier-more')),false);
    await owner(component => component.store.filter.set('running')); await finish();
    await owner(component => component.store.filter.set(null)); await finish();
    assert.equal((await visible()).length,19);
    yield {name:`${theme}-fully-expanded-archive-retained`,inspect};
    await capture.click('[data-task-id="11"] .earlier-fewer'); await finish();
    assert.equal((await visible()).length,6);
    await owner(component => component.store.selectProject('all')); await finish();
    assert.equal((await visible()).length,6);
    yield {name:`${theme}-explicit-show-fewer-retained`,inspect};
  }
}
