import assert from 'node:assert/strict';

/** The agent menu through its supported Angular API: rail, models, thinking, usage and lifetimes. */
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
  const selected = () => capture.evaluate(() => document.querySelector('.agent-settings [role="option"][aria-selected="true"]')?.textContent.trim());
  const listHeight = () => capture.evaluate(() => document.querySelector('.agent-settings .models').getBoundingClientRect().height);
  const base = { mark: 'Cl', harness: 'claude', model: 'opus', thinking: 'High' };
  for (const theme of ['light', 'dark']) {
    await capture.theme(theme); await capture.viewport(1440, 960);
    await capture.component('ex-agent-picker-demo', (c, base) => {
      c.agent.set({ ...base, preset: 'Deep work' });
      c.busy.set(false); c.disabled.set(false); c.locked.set(true);
    }, base);
    await open();
    // A started session: no rail, the harness named and locked, focus on the chosen model.
    const locked = await capture.evaluate(() => ({
      width: document.querySelector('.agent-settings').getBoundingClientRect().width,
      rail: !!document.querySelector('.agent-settings [aria-label="Harness"]'),
      heading: document.querySelector('.agent-settings .heading').textContent,
      logo: !!document.querySelector('.agent-settings .heading ex-agent-mark svg'),
      focus: document.activeElement?.textContent.trim(),
    }));
    assert.equal(locked.width, 296); assert.equal(locked.rail, false); assert.equal(locked.logo, true);
    assert.match(locked.heading, /Claude Code/); assert.match(locked.heading, /Deep work/);
    assert.equal(locked.focus, 'Opus 5.5');
    yield { name: theme + '-locked', selector: '.agent-settings', inspect: ['.agent-settings', '.heading', '.models', '.tune', 'footer'] };

    // Arrow keys move without choosing; ↵ chooses and keeps the menu open.
    await capture.press('ArrowDown');
    assert.equal(await selected(), 'Opus 5.5');
    await capture.press('Enter');
    await capture.waitFor(() => document.querySelector('ex-agent-picker > button')?.textContent.includes('Sonnet 5.5'));
    assert.equal(await selected(), 'Sonnet 5.5');
    // Sonnet has no Extra high or Max: the track holds three levels and keeps High.
    assert.equal(await capture.evaluate(() => document.querySelector('[aria-label="Thinking level"]').max), '2');
    assert.equal(await capture.evaluate(() => document.querySelector('[aria-label="Thinking level"]').getAttribute('aria-valuetext')), 'High');
    await capture.evaluate(() => document.querySelector('[aria-label="Thinking level"]').focus());
    await capture.press('Home');
    await capture.waitFor(() => document.querySelector('ex-agent-picker > button .sub')?.textContent.includes('Low'));
    await capture.click('.agent-settings button[aria-label="Fast mode"]');
    await capture.waitFor(() => !!document.querySelector('ex-agent-picker .fast'));
    assert.equal(await capture.evaluate(() => document.querySelector('.agent-settings button[aria-label="Fast mode"]').getAttribute('aria-pressed')), 'true');
    assert.equal(await capture.evaluate(() => !!document.querySelector('.agent-settings .save')), true);
    await finish();
    yield { name: theme + '-adjusted', selector: '.agent-settings', inspect: ['.agent-settings', '.models', '.tune', 'footer', 'ex-agent-picker > button'] };
    await close();
    assert.equal(await capture.evaluate(() => document.activeElement === document.querySelector('ex-agent-picker > button')), true);
    // Reopening interrupts the retained exit rather than creating a second portal.
    await capture.click('ex-agent-picker > button'); await capture.press('Escape');
    await open();
    assert.equal(await capture.evaluate(() => document.querySelectorAll('.agent-settings').length), 1);
    await close();

    // An unstarted session: the rail of harness logos, its thumb on the choice.
    await capture.component('ex-agent-picker-demo', (c, base) => { c.locked.set(false); c.agent.set(base); c.usage(true); }, base);
    await capture.hover('ex-agent-picker-demo h1');
    await capture.hover('ex-agent-picker > button');
    await capture.waitFor(() => !!document.querySelector('.usage-card:not(.leaving)')); await finish();
    assert.equal(await capture.evaluate(() => !!document.querySelector('.usage-card button, .usage-card input')), false);
    yield { name: theme + '-usage-card', selector: '.usage-card', inspect: ['.usage-card', 'ex-agent-plan-meter'] };
    await open(); await capture.waitFor(() => !document.querySelector('.usage-card'));
    const rail = await capture.evaluate(() => {
      const menu = document.querySelector('.agent-settings').getBoundingClientRect();
      const thumb = document.querySelector('.rail .ex-fitted-highlight').getBoundingClientRect();
      const chosen = document.querySelector('.rail [aria-checked="true"]').getBoundingClientRect();
      return {
        width: menu.width,
        logos: [...document.querySelectorAll('.rail [role="radio"]')].map(b => [b.getAttribute('aria-label'), !!b.querySelector('svg')]),
        thumb: [thumb.top - chosen.top, thumb.height - chosen.height],
        plan: document.querySelector('.agent-settings .plan')?.textContent.trim(),
        tone: document.querySelector('.agent-settings .plan')?.dataset.tone,
        context: document.querySelector('.agent-settings .context')?.dataset.tone,
      };
    });
    assert.equal(rail.width, 340);
    assert.deepEqual(rail.logos, [['Claude Code', true], ['Codex', true], ['Pi', true], ['OpenCode', true], ['Local runner', false]]);
    assert.deepEqual(rail.thumb, [0, 0]);
    assert.equal(rail.plan, '12% left'); assert.equal(rail.tone, 'attention'); assert.equal(rail.context, 'attention');
    const unlockedList = await listHeight();
    yield { name: theme + '-rail-usage', selector: '.agent-settings', inspect: ['.agent-settings', '.rail', '.heading', '.status', '.models', '.context'] };
    await capture.click('.agent-settings button.compact');
    await capture.waitFor(() => !document.querySelector('.agent-settings button.compact'));
    assert.equal(await capture.evaluate(() => !!document.activeElement?.matches('.agent-settings .heading')), true);

    // Changing harness keeps the list's height, and the thumb glides to the new logo.
    await capture.click('.rail [aria-label="Codex"]');
    await capture.waitFor(() => document.querySelector('ex-agent-picker > button')?.getAttribute('aria-label').includes('Codex'));
    assert.equal(await capture.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Codex');
    await capture.press('ArrowDown');
    await capture.waitFor(() => document.querySelector('ex-agent-picker > button')?.getAttribute('aria-label').includes('Pi'));
    await finish();
    assert.equal(await capture.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Pi');
    assert.equal(await listHeight(), unlockedList, 'Switching harness must not resize the list');
    yield { name: theme + '-pi', selector: '.agent-settings', inspect: ['.agent-settings', '.rail', '.models'] };

    // A long list gets a filter; typing from the list starts it, Escape clears it first.
    await capture.press('End');
    await capture.waitFor(() => document.querySelector('.rail [aria-checked="true"]')?.getAttribute('aria-label') === 'Local runner');
    await capture.press('ArrowUp');
    await capture.waitFor(() => !!document.querySelector('.agent-settings .filter'));
    await finish();
    yield { name: theme + '-opencode', selector: '.agent-settings', inspect: ['.agent-settings', '.filter', '.models'] };
    await capture.evaluate(() => document.querySelector('.agent-settings [role="option"]').focus());
    await capture.press('k');
    assert.equal(await capture.evaluate(() => document.activeElement?.matches('.filter input')), true);
    await capture.cdp('Input.insertText', { text: 'im' });
    await capture.waitFor(() => document.querySelectorAll('.agent-settings [role="option"]').length === 1);
    await capture.press('Enter');
    await capture.waitFor(() => document.querySelector('ex-agent-picker > button')?.textContent.includes('Kimi K3'));
    await finish();
    yield { name: theme + '-filtered', selector: '.agent-settings', inspect: ['.agent-settings', '.filter', '.models'] };
    await capture.press('Escape');
    assert.equal(await capture.evaluate(() => document.querySelector('.filter input').value), '');
    assert.equal(await capture.evaluate(() => !!document.querySelector('.agent-settings:not(.leaving)')), true);

    // An update keeps focus and position; choices take no input until it applies.
    await capture.click('.rail [aria-label="Claude Code"]');
    await capture.waitFor(() => document.querySelector('ex-agent-picker > button')?.getAttribute('aria-label').includes('Claude Code'));
    await capture.component('ex-agent-picker-demo', c => c.busy.set(true)); await finish();
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.equal(await capture.evaluate(() => !!document.querySelector('.agent-settings').contains(document.activeElement)), true);
    assert.equal(await capture.evaluate(() => document.querySelector('.agent-settings [role="status"]').textContent.trim()), 'Updating…');
    yield { name: theme + '-updating', selector: '.agent-settings', inspect: ['.agent-settings', '.status', '.tune'] };
    await capture.component('ex-agent-picker-demo', c => c.busy.set(false));
    await capture.click('.agent-settings .save');
    await capture.waitFor(() => !document.querySelector('.agent-settings'));
    await capture.waitFor(() => document.querySelector('ex-agent-picker > button')?.textContent.includes('Saved mix'));

    await capture.viewport(360, 760); await capture.reducedMotion(true);
    await open();
    const narrow = await capture.evaluate(() => {
      const menu = document.querySelector('.agent-settings'), box = menu.getBoundingClientRect();
      return { left: box.left, right: box.right, viewport: innerWidth, scroll: menu.scrollWidth, width: menu.clientWidth };
    });
    assert.ok(narrow.left >= 15 && narrow.right <= narrow.viewport - 15 && narrow.scroll <= narrow.width + 1, JSON.stringify(narrow));
    yield { name: theme + '-narrow-reduced', inspect: ['.agent-settings', '.rail', '.models', '.tune'] };
    await capture.component('ex-agent-picker-demo', c => c.disabled.set(true));
    await capture.waitFor(() => !document.querySelector('.agent-settings'));
    assert.equal(await capture.evaluate(() => document.querySelector('ex-agent-picker > button').disabled), true);
    await capture.component('ex-agent-picker-demo', c => { c.disabled.set(false); c.usage(false); });
    await capture.reducedMotion(false);
  }
  // Unmount an open portal and pending hover disclosure through the real router.
  await capture.viewport(1440, 960); await open();
  await capture.evaluate(() => document.querySelector('nav a[routerlink="/foundations"]').click());
  await capture.waitFor(() => !document.querySelector('ex-agent-picker-demo') && !!document.querySelector('ex-foundations-demo'));
  assert.equal(await capture.evaluate(() => !!document.querySelector('.agent-settings, .usage-card')), false);
}
