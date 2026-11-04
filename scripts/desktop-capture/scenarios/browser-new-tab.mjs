import assert from 'node:assert/strict';

// Production browser owner with the isolated /task-browser preview transport.
export default async function* (capture) {
  await capture.waitFor(() => document.querySelector('ex-task-browser .start-page'));
  const state = () => capture.component('ex-task-browser', component => component.store.state());
  const address = 'ex-task-browser [aria-label="Page address"]';
  const add = 'ex-task-browser [aria-label="New browser tab (⌘T)"]';
  for (const theme of ['light', 'dark']) {
    await capture.theme(theme);
    await capture.viewport(1000, 720);
    await capture.reducedMotion(false);
    const initial = await state();
    assert.equal(initial.tabs.length, 1);
    assert.equal(initial.tabs[0].url, '');
    assert.equal(await capture.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Page address');
    await capture.motion.finish();
    await capture.settle();
    yield { name: `${theme}-default-tab`, selector: 'ex-task-browser', inspect: [address, '.start-page', '.server-options'] };

    await capture.click(add);
    await capture.waitFor(() => document.querySelectorAll('ex-task-browser [role="tab"]').length === 2);
    assert.equal((await state()).tabs.length, 2);
    assert.equal(await capture.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Page address');
    assert.equal(await capture.evaluate(() => !!document.querySelector('ex-task-browser [role="dialog"]')), false);
    await capture.fill(address, 'https://example.com');
    assert.equal((await state()).tabs.at(-1).url, '');
    yield { name: `${theme}-address-draft`, selector: 'ex-task-browser' };
    await capture.press('Enter');
    await capture.waitFor(() => document.querySelector('ex-task-browser [role="alert"]'));
    assert.equal((await state()).tabs.at(-1).url, 'https://example.com');
    yield { name: `${theme}-navigation-preview-error`, selector: 'ex-task-browser' };

    await capture.press('t', 2);
    await capture.waitFor(() => document.querySelectorAll('ex-task-browser [role="tab"]').length === 3);
    assert.equal((await state()).tabs.at(-1).url, '');
    assert.equal(await capture.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Page address');
    await capture.viewport(440, 560);
    await capture.reducedMotion(true);
    await capture.settle();
    const bounds = await capture.evaluate(() => {
      const root = document.querySelector('ex-task-browser');
      const start = root.querySelector('.start-page').getBoundingClientRect();
      const toolbar = root.querySelector('.toolbar').getBoundingClientRect();
      return { start: { width: start.width, height: start.height, bottom: start.bottom }, toolbar: { right: toolbar.right } };
    });
    assert.ok(bounds.start.width > 0 && bounds.start.height > 0);
    assert.ok(bounds.toolbar.right <= 440);
    yield { name: `${theme}-narrow-reduced-motion`, selector: 'ex-task-browser', metadata: bounds };
    await capture.click('ex-task-browser .server-options button:first-child');
    await capture.waitFor(() => document.querySelector('ex-task-browser [role="alert"]'));
    assert.equal((await state()).tabs.at(-1).url, 'http://localhost:3000');

    await capture.component('ex-task-browser', async component => {
      for (const tab of component.store.state().tabs) await component.store.command({ kind: 'close', tabId: tab.id });
    });
    await capture.waitFor(() => !document.querySelector('ex-task-browser [role="tab"]'));
    yield { name: `${theme}-last-tab-closed`, selector: 'ex-task-browser' };
    await capture.viewport(1000, 720);
    await capture.click(add);
    await capture.waitFor(() => document.querySelectorAll('ex-task-browser [role="tab"]').length === 1);
  }
}
