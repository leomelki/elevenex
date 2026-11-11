import assert from 'node:assert/strict';

/** Real task/browser chrome with the isolated mixed-engine preview provider. */
export default async function* (capture) {
  await capture.evaluate(() => { location.href = '/remote-tabs'; });
  await capture.waitFor(() => document.querySelector('ex-task-browser .start-page'));
  const state = () => capture.component('ex-task-browser', component => component.store.state());
  for (const theme of ['light', 'dark']) {
    await capture.theme(theme);
    await capture.viewport(900, 620);
    await capture.reducedMotion(false);
    const remote = (await state()).tabs.find(tab => tab.execution === 'remote');
    await capture.click('[aria-label="New tab options"]');
    await capture.waitFor(() => document.querySelector('[role="menu"]'));
    yield { name: `${theme}-new-tab-menu`, inspect: ['[role="menu"]', '[aria-label="New tab options"]'] };
    await capture.press('ArrowDown'); await capture.press('Enter');
    await capture.waitFor(() => document.querySelector('.local-only'));
    assert.equal((await state()).tabs.at(-1).agentAccess, 'unavailable');
    await capture.waitFor(() => document.querySelector('.driver')?.textContent.trim() === 'Local · Proxied');
    assert.equal(await capture.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Page address');
    assert.equal(await capture.evaluate(() => !!document.querySelector('[aria-label="Point and ask (⇧⌘C)"]')), false);
    await capture.motion.finish(); await capture.settle();
    yield { name: `${theme}-local-start`, selector: 'ex-task-browser', inspect: ['.local-only', '.toolbar', '.start-page'] };
    await capture.viewport(440, 560); await capture.reducedMotion(true); await capture.settle();
    const bounds = await capture.evaluate(() => {
      const toolbar = document.querySelector('.toolbar').getBoundingClientRect(), address = document.querySelector('[aria-label="Page address"]').getBoundingClientRect();
      return { right: toolbar.right, addressWidth: address.width, windowWidth: innerWidth };
    });
    assert.ok(bounds.right <= bounds.windowWidth); assert.ok(bounds.addressWidth > 40);
    yield { name: `${theme}-local-narrow`, selector: 'ex-task-browser', metadata: bounds };
    yield { name: `${theme}-local-toolbar`, selector: '.toolbar' };
    await capture.hover('.local-only');
    await capture.waitFor(() => document.querySelector('ex-tooltip'));
    yield { name: `${theme}-local-routing-tooltip`, inspect: ['ex-tooltip', '.local-only'] };
    await capture.click('.local-only');
    await capture.waitFor(() => document.querySelector('[role="dialog"]'));
    assert.ok(await capture.evaluate(() => document.querySelector('[role="dialog"]').textContent.includes('Agents cannot see or control this tab')));
    assert.equal(await capture.evaluate(() => /Block agent|Allow agent/.test(document.querySelector('[role="dialog"]').textContent)), false);
    yield { name: `${theme}-local-details`, inspect: ['[role="dialog"]'] };
    await capture.press('Escape');
    await capture.waitFor(() => !document.querySelector('[role="dialog"]'));
    await capture.fill('[aria-label="Page address"]', 'http://localhost:3000'); await capture.press('Enter');
    await capture.waitFor(() => document.querySelector('.page-state[role="alert"]'));
    yield { name: `${theme}-local-page-error`, selector: 'ex-task-browser' };
    await capture.component('ex-task-browser', component => component.store.pending.set(1));
    assert.equal(await capture.evaluate(() => document.querySelector('[aria-label="New tab options"]').disabled), true);
    yield { name: `${theme}-creation-busy`, selector: 'ex-task-browser' };
    await capture.component('ex-task-browser', component => component.store.pending.set(0));
    await capture.component('ex-task-browser', (component, id) => component.store.command({ kind: 'select', tabId: id }), remote.id);
    await capture.waitFor(() => !document.querySelector('.local-only'));
    await capture.waitFor(() => document.querySelector('.driver')?.textContent.trim() === 'Streaming');
    assert.equal(await capture.evaluate(() => !!document.querySelector('[aria-label="Point and ask (⇧⌘C)"]')), true);
    yield { name: `${theme}-return-to-remote`, selector: 'ex-task-browser' };
    for (const driver of ['agent', 'needs', 'you']) {
      await capture.component('ex-task-browser', (component, value) => component.store.state.update(state => ({ ...state, tabs: state.tabs.map(tab => tab.id === state.active ? { ...tab, driver: value } : tab) })), driver);
      assert.equal(await capture.evaluate(() => document.querySelector('.driver').textContent.trim()), 'Streaming');
    }
    yield { name: `${theme}-streaming-toolbar`, selector: '.toolbar' };
  }
  await capture.evaluate(() => { location.href = '/task-browser'; });
  await capture.waitFor(() => document.querySelector('.driver')?.textContent.trim() === 'Local');
  for (const theme of ['light', 'dark']) {
    await capture.theme(theme);
    yield { name: `${theme}-direct-local-toolbar`, selector: '.toolbar' };
  }
}
