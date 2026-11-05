import assert from 'node:assert/strict';

/** Production browser controls with the preview-only task transport. */
export default async function* browserPlacement(capture) {
  await capture.evaluate(() => { location.href = '/task-browser'; });
  await capture.waitFor(() => document.querySelector('.start-page'));
  for (const theme of ['light', 'dark']) {
    await capture.theme(theme);
    await capture.component('ex-task-browser', component => component.showDialog('tools'));
    await capture.waitFor(() => document.querySelector('[role="dialog"] ex-dropdown button'));
    await capture.motion.finish();
    assert.equal(await capture.evaluate(() => document.querySelector('[role="dialog"] ex-dropdown button').disabled), false);
    assert.equal(await capture.evaluate(() => [...document.querySelectorAll('[role="dialog"] button')].some(button => ['Direct', 'Stream'].includes(button.textContent.trim()))), false);
    yield { name: theme + '-location', inspect: ['[role="dialog"]', 'ex-dropdown'] };
    await capture.click('[role="dialog"] ex-dropdown button');
    await capture.waitFor(() => document.querySelectorAll('[role="menuitemradio"]').length === 3);
    await capture.motion.finish();
    yield { name: theme + '-choices', inspect: ['[role="menu"]'] };
    await capture.press('End'); await capture.press('Enter');
    await capture.waitFor(() => document.querySelector('ex-dropdown button')?.textContent.includes('Remote'));
    assert.equal(await capture.evaluate(() => document.activeElement.closest('ex-dropdown') !== null), true, 'Menu restores focus to its trigger');
    await capture.press('Escape');
    await capture.waitFor(() => !document.querySelector('[role="dialog"]'));
  }
  await capture.viewport(520, 800); await capture.reducedMotion(true);
  await capture.component('ex-task-browser', component => component.showDialog('tools'));
  yield { name: 'narrow-reduced-motion', inspect: ['[role="dialog"]', 'ex-dropdown'] };
  await capture.component('ex-task-browser', async component => {
    component.dialogOpen.set(false);
    await component.store.command({ kind: 'navigate', tabId: component.current().id, url: 'http://localhost:3000' });
  });
  await capture.waitFor(() => !document.querySelector('[role="dialog"]'));
  await capture.component('ex-task-browser', component => component.showDialog('tools'));
  await capture.waitFor(() => document.querySelector('[role="dialog"] ex-dropdown button')?.disabled);
  yield { name: 'loaded-location-disabled', inspect: ['[role="dialog"]', 'ex-dropdown'] };
  await capture.component('ex-task-browser', component => {
    component.store.state.update(state => ({ ...state, placement: 'desktop', availablePlacements: ['desktop'], capabilities: { embedded: true, audio: true, accessibility: true, filePicker: true, downloads: true } }));
  });
  await capture.waitFor(() => document.querySelector('[aria-label="Browser location: Local"]')?.disabled);
  yield { name: 'local-only', inspect: ['[role="dialog"]', 'ex-dropdown'] };
}
