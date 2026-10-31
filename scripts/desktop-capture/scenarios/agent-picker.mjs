import assert from 'node:assert/strict';

/** Matches the actual standalone ZIP, then exercises the supported Angular API. */
export default async function* (capture) {
  await capture.evaluate(() => { location.href = '/agent-picker'; });
  await capture.waitFor(() => !!document.querySelector('ex-agent-picker-demo'));
  // Vite handles window errors before CDP reports them as uncaught exceptions.
  await capture.evaluate(() => window.addEventListener('error', event => console.error(event.message)));
  const finish = async () => {
    await capture.settle();
    await capture.waitFor(() => document.getAnimations().every(a => !Number.isFinite(a.effect?.getComputedTiming().endTime) || a.playState !== 'running'));
  };
  const open = async () => { await capture.click('ex-agent-picker > button'); await capture.waitFor(() => document.querySelector('.agent-settings')?.getAttribute('aria-hidden') === 'false'); await finish(); };
  const close = async () => { await capture.press('Escape'); await capture.waitFor(() => !document.querySelector('.agent-settings')); };
  for (const theme of ['light', 'dark']) {
    await capture.theme(theme); await capture.viewport(1440, 960);
    await capture.component('ex-agent-picker-demo', c => {
      c.agent.set({ preset: 'Deep work', mark: 'Cl', harness: 'claude', model: 'opus', thinking: 'High' });
      c.busy.set(false); c.disabled.set(false); c.locked.set(true);
    });
    await open();
    const geometry = await capture.evaluate(() => {
      const menu = document.querySelector('.agent-settings').getBoundingClientRect();
      return { width:menu.width, height:menu.height, rows:[...document.querySelectorAll('.field')].map(row => row.getBoundingClientRect().height), labels:[...document.querySelectorAll('.field-label')].map(label => ({ left:label.getBoundingClientRect().left-menu.left, width:label.getBoundingClientRect().width })), valueLeft:document.querySelector('.harness').getBoundingClientRect().left-menu.left };
    });
    // These are measured reference geometry, including its content-box padding.
    assert.equal(geometry.width, 368); assert.equal(geometry.height, 211);
    assert.deepEqual(geometry.rows, [36,36,36,36]);
    assert.equal(geometry.valueLeft, 104);
    assert.deepEqual(geometry.labels, Array(4).fill({left:12,width:84}));
    yield { name:theme+'-reference', selector:'.agent-settings', inspect:['.agent-settings','.field','.field-label','.harness','footer','ex-segmented'] };
    await capture.click('.agent-settings button[aria-label^="Model:"]');
    await capture.press('End'); await capture.press('Enter');
    await capture.waitFor(() => document.querySelector('.agent-settings button[aria-label^="Model:"]')?.textContent.includes('Sonnet'));
    assert.equal(await capture.evaluate(() => document.querySelector('[aria-label="Thinking level"] button[aria-label="Max"]').disabled), true);
    await capture.click('[aria-label="Thinking level"] button[aria-label="Low"]');
    await capture.click('ex-switch button[aria-label="Fast mode"]');
    await capture.waitFor(() => !!document.querySelector('ex-agent-picker .fast'));
    await capture.click('.agent-settings button[aria-label^="Model:"]'); await capture.press('Escape');
    assert.equal(await capture.evaluate(() => !!document.querySelector('.agent-settings:not(.leaving)')), true);
    await capture.press('Escape');
    assert.equal(await capture.evaluate(() => document.querySelector('.agent-settings')?.hasAttribute('inert')), true);
    assert.equal(await capture.evaluate(() => document.activeElement === document.querySelector('ex-agent-picker > button')), true);
    // Reopening interrupts the retained exit rather than creating a second portal.
    await open();
    assert.equal(await capture.evaluate(() => document.querySelectorAll('.agent-settings').length), 1);
    await close();
    await capture.component('ex-agent-picker-demo', c => c.usage(true));
    await capture.hover('ex-agent-picker-demo h1');
    await capture.hover('ex-agent-picker > button');
    await capture.waitFor(() => !!document.querySelector('.usage-card:not(.leaving)')); await finish();
    assert.equal(await capture.evaluate(() => !!document.querySelector('.usage-card button, .usage-card input')), false);
    yield { name:theme+'-usage-card', selector:'.usage-card', inspect:['.usage-card','ex-agent-plan-meter'] };
    await open(); await capture.waitFor(() => !document.querySelector('.usage-card'));
    assert.equal(await capture.evaluate(() => document.querySelector('.agent-settings').getBoundingClientRect().height), 419);
    yield { name:theme+'-usage-menu', selector:'.agent-settings', inspect:['.agent-settings','ex-agent-usage','.plan-heading','.limit'] };
    await close();
    // Wait beyond disclosure and exit: focus restoration must not open usage.
    await new Promise(resolve => setTimeout(resolve, 550));
    assert.equal(await capture.evaluate(() => !!document.querySelector('.usage-card')), false);
    assert.equal(await capture.evaluate(() => document.activeElement === document.querySelector('ex-agent-picker > button')), true);
    yield { name:theme+'-usage-dismissed', inspect:['ex-agent-picker > button','.usage-card'] };
    await capture.hover('ex-agent-picker-demo h1');
    await capture.hover('ex-agent-picker > button');
    await capture.waitFor(() => !!document.querySelector('.usage-card:not(.leaving)'));
    await capture.hover('ex-agent-picker-demo h1');
    await capture.waitFor(() => !document.querySelector('.usage-card'));
    await open();
    await capture.click('.agent-settings button.compact');
    await capture.waitFor(() => !document.querySelector('.agent-settings button.compact'));
    assert.equal(await capture.evaluate(() => !!document.activeElement?.matches('.agent-settings .heading')), true);
    await capture.component('ex-agent-picker-demo', c => c.busy.set(true)); await finish();
    assert.equal(await capture.evaluate(() => [...document.querySelectorAll('.agent-settings button')].every(button => button.disabled)), true);
    assert.equal(await capture.evaluate(() => !!document.querySelector('.agent-settings').contains(document.activeElement)), true);
    await capture.press('Tab'); await capture.press('Tab', 8);
    assert.equal(await capture.evaluate(() => !!document.activeElement?.matches('.agent-settings .heading')), true);
    yield { name:theme+'-updating', selector:'.agent-settings', inspect:['.agent-settings','footer'] };
    await capture.component('ex-agent-picker-demo', c => c.busy.set(false));
    await capture.click('.agent-settings footer button');
    await capture.waitFor(() => !document.querySelector('.agent-settings'));
    await capture.waitFor(() => document.querySelector('ex-agent-picker > button')?.textContent.includes('Saved mix'));
    await capture.component('ex-agent-picker-demo', c => c.locked.set(false));
    await open();
    await capture.click('[aria-label="Harness"] button[aria-label="Codex"]');
    assert.equal(await capture.evaluate(() => !!document.querySelector('.agent-settings:not(.leaving)')?.contains(document.activeElement)), true);
    await capture.waitFor(() => document.querySelector('.agent-settings button[aria-label^="Model:"]')?.textContent.includes('GPT-5 Codex'));
    await capture.waitFor(() => document.querySelector('ex-agent-picker > button')?.getAttribute('aria-label').includes('Codex'));
    await capture.viewport(360, 760); await capture.reducedMotion(true);
    await capture.waitFor(() => {
      const box = document.querySelector('.agent-settings')?.getBoundingClientRect();
      return box && box.left >= 15 && box.right <= innerWidth - 15;
    });
    const narrow = await capture.evaluate(() => {
      const menu=document.querySelector('.agent-settings'), box=menu.getBoundingClientRect();
      return { left:box.left, right:box.right, viewport:innerWidth, scroll:menu.scrollWidth, width:menu.clientWidth };
    });
    assert.ok(narrow.left >= 15 && narrow.right <= narrow.viewport-15 && narrow.scroll <= narrow.width+1, JSON.stringify(narrow));
    yield { name:theme+'-narrow-reduced', inspect:['.agent-settings','.field','footer','ex-segmented'] };
    await capture.component('ex-agent-picker-demo', c => c.disabled.set(true));
    await capture.waitFor(() => !document.querySelector('.agent-settings'));
    assert.equal(await capture.evaluate(() => document.querySelector('ex-agent-picker > button').disabled), true);
    await capture.reducedMotion(false);
  }
  // Unmount an open portal and pending hover disclosure through the real router.
  await capture.component('ex-agent-picker-demo', c => c.disabled.set(false));
  await capture.viewport(1440,960); await open();
  // An owning router can replace a feature while its backdrop is still open.
  await capture.evaluate(() => document.querySelector('nav a[routerlink="/foundations"]').click());
  await capture.waitFor(() => !document.querySelector('ex-agent-picker-demo') && !!document.querySelector('ex-foundations-demo'));
  assert.equal(await capture.evaluate(() => !!document.querySelector('.agent-settings, .usage-card')), false);
}
