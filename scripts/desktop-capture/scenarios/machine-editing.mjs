import assert from 'node:assert/strict';

/** Home's real production owner, with isolated platform data. */
export default async function* (capture) {
  const owner = (fn, data) => capture.component('ex-machine-startup-demo', fn, data);
  const app = (fn, data) => capture.component('ex-machine-app', fn, data);
  const settle = async () => {
    await capture.settle(); await capture.motion.finish();
    await capture.waitFor(() => document.getAnimations().every(a => !Number.isFinite(a.effect?.getComputedTiming().endTime) || a.playState !== 'running'));
  };
  const menu = 'ex-machine-menu';
  const more = id => `[data-machine="${id}"] + .more`;
  const openMenu = async id => {
    await capture.evaluate(id => document.querySelector(`[data-machine="${id}"] + .more`).focus(), id);
    await capture.hover(more(id)); await capture.click(more(id));
  };
  const editValue = async (label, text) => {
    await capture.click(`ex-edit-machine ex-set-value button[aria-label^="${label}:"]`);
    await capture.waitFor(() => document.querySelector('ex-edit-machine input'));
    await capture.fill('ex-edit-machine input', text);
    await capture.press('Enter');
  };
  await capture.evaluate(() => { location.href = '/machine-startup'; });
  await capture.waitFor(() => document.querySelector('ex-machine-app [data-machine="local"]'));
  for (const theme of ['light', 'dark']) {
    await capture.viewport(1100, 820); await capture.theme(theme); await capture.reducedMotion(false);
    await owner(async c => { c.platform.reset(true); c.platform.ready(); await c.platform.saveRemoteHost({ name: 'dev-box', host: 'dev.internal', user: 'leo', port: 22, hue: 'ocean' }); await c.platform.saveRemoteHost({ name: 'staging-1', host: 'staging', hue: 'rust' }); await c.platform.saveRemoteHost({ name: 'gpu-runner', host: 'gpu', hue: 'steel' }); });
    await app(c => { c.home(); c.launcher.currentId.set(null); }); await settle();
    const ids = await app(c => c.actions.machines().filter(m => m.kind === 'ssh').map(m => m.id));
    const [dev, staging] = ids;
    await capture.hover(`[data-machine="${dev}"]`); await settle();
    assert.equal(await capture.evaluate(() => !!document.querySelector('[data-machine] button')), false);
    yield { name: `${theme}-hover-menu`, inspect: ['ex-machine-home', more(dev)] };
    await openMenu(dev); await capture.waitFor(() => document.querySelector('ex-machine-menu [role=menuitem]'));
    await capture.waitFor(() => document.activeElement?.closest('ex-machine-menu')); await settle();
    yield { name: `${theme}-server-menu`, inspect: [menu, more(dev)] };
    await capture.press('Escape'); await capture.waitFor(() => !document.querySelector('ex-machine-menu'));
    assert.equal(await capture.evaluate(id => document.activeElement === document.querySelector(`[data-machine="${id}"] + .more`), dev), true);
    await openMenu(dev); await capture.waitFor(() => document.querySelector('ex-machine-menu'));
    await capture.motion.freeze(); await capture.click('ex-machine-menu button:first-child');
    await capture.waitFor(() => document.querySelector('ex-edit-machine'));
    for (const time of [0, 180, 560]) {
      await capture.evaluate(time => { for (const a of document.getAnimations()) a.currentTime = time; }, time); await capture.settle();
      yield { name: `${theme}-edit-morph-${time}`, inspect: ['ex-edit-machine', '.ex-modal-surface', `[data-machine="${dev}"]`] };
    }
    await capture.motion.finish(); await capture.motion.play(); await settle();
    await editValue('Name', 'Build box'); await capture.click('ex-edit-machine button[aria-label="plum"]');
    yield { name: `${theme}-edit-look`, inspect: ['ex-edit-machine'] };
    await capture.click('ex-edit-machine button[type=submit]'); await settle();
    await capture.waitFor(() => !document.querySelector('ex-edit-machine'));
    assert.equal(await app(c => c.actions.machines().find(m => m.name === 'Build box')?.hue), 'plum');
    await openMenu(dev); await capture.waitFor(() => document.querySelector('ex-machine-menu'));
    await capture.click('ex-machine-menu button:first-child'); await settle();
    await editValue('Host', 'build.internal'); await editValue('Port', '2200');
    assert.match(await capture.evaluate(() => document.querySelector('ex-edit-machine').textContent), /Saving reconnects/);
    yield { name: `${theme}-edit-destination`, inspect: ['ex-edit-machine'] };
    await capture.click('ex-edit-machine button[type=submit]'); await settle();
    await capture.waitFor(() => !document.querySelector('ex-edit-machine'));
    assert.equal(await app(c => c.launcher.pendingId()), null);
    assert.equal(await app(c => c.launcher.open()), false);
    yield { name: `${theme}-reconnecting-on-card`, inspect: [`[data-machine="${dev}"]`, 'ex-title-island'] };
    // Context menu starts exactly at the trusted right-click position.
    const point = await capture.evaluate(id => { const r = document.querySelector(`[data-machine="${id}"]`).getBoundingClientRect(); return { x: r.x + 40, y: r.y + 60 }; }, staging);
    await capture.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'right', buttons: 2, clickCount: 1, ...point });
    await capture.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'right', buttons: 0, clickCount: 1, ...point });
    await capture.waitFor(() => document.querySelector('ex-machine-menu'));
    const rect = await capture.evaluate(() => { const r = document.querySelector('ex-machine-menu').getBoundingClientRect(); return { x: r.x, y: r.y }; });
    assert.ok(Math.abs(rect.x - point.x) < 2 && Math.abs(rect.y - point.y) < 2, JSON.stringify({ rect, point }));
    yield { name: `${theme}-context-menu`, inspect: [menu] };
    await capture.click('ex-machine-menu button:last-child');
    await capture.waitFor(() => document.querySelector('ex-toast')?.textContent.includes('Removed staging-1'));
    const probe = await capture.measureMotion(['ex-machine-home .grid', 'ex-machine-card', 'ex-machine-card .wrap'], 700);
    await capture.waitFor(id => !document.querySelector(`[data-machine="${id}"]`), staging);
    yield { name: `${theme}-removed`, inspect: ['ex-machine-home', 'ex-toast-stack'], metadata: { probe } };
    await capture.click('ex-toast button[exButton]');
    await capture.waitFor(id => document.querySelector(`[data-machine="${id}"]`), staging); await settle();
    assert.deepEqual(await app(c => c.actions.machines().filter(m => m.kind === 'ssh').map(m => m.id)), ids);
    yield { name: `${theme}-undo`, inspect: ['ex-machine-home'] };
    const removalMotion = await app(async (c, data) => {
      const machine = c.actions.machines().find(m => m.id === data.staging), card = document.querySelector(`[data-machine="${data.staging}"]`), wrap = card.parentElement;
      const neighbour = document.querySelector(`[data-machine="${data.neighbour}"]`).closest('ex-machine-card');
      const samples = [], start = performance.now();
      const removing = c.actions.act({ action: 'remove', event: { machine, card, x: 0, y: 0, fromButton: false } });
      while (performance.now() - start < 750) {
        await new Promise(requestAnimationFrame);
        samples.push({ time: performance.now() - start, opacity: wrap.isConnected ? +getComputedStyle(wrap).opacity : null, x: neighbour.getBoundingClientRect().x });
      }
      await removing; return samples;
    }, { staging, neighbour: ids[2] });
    assert.ok(removalMotion.some(s => s.opacity > .05 && s.opacity < .95), 'The departing card must visibly fade');
    const xs = removalMotion.map(s => s.x), distance = Math.max(...xs) - Math.min(...xs);
    yield { name: `${theme}-removal-motion`, inspect: ['ex-machine-home'], metadata: { removalMotion, distance } };
    assert.ok(distance > 150 && xs.some(x => x > Math.min(...xs) + 10 && x < Math.max(...xs) - 10), `The neighbour must slide after the fade: ${JSON.stringify({ distance, xs })}`);
    await capture.click('ex-toast button[exButton]'); await settle();
    await owner(c => c.platform.ready()); await settle();
    await openMenu(dev); await capture.waitFor(() => document.querySelector('ex-machine-menu'));
    assert.match(await capture.evaluate(() => document.querySelector('ex-machine-menu').textContent), /Disconnect/);
    assert.match(await capture.evaluate(() => document.querySelector('ex-machine-menu button:last-child').textContent), /Remove…/);
    await capture.click('ex-machine-menu button:last-child'); await settle();
    assert.match(await capture.evaluate(() => document.querySelector('ex-edit-machine').textContent), /window is on it/);
    yield { name: `${theme}-confirm-occupied`, inspect: ['ex-edit-machine'] };
    await capture.click('ex-edit-machine footer button:last-child'); await settle();
    await capture.waitFor(() => !document.querySelector('ex-edit-machine'));
    assert.equal(await capture.evaluate(() => !!document.activeElement?.closest('ex-machine-home')), true);
    yield { name: `${theme}-occupied-removed`, inspect: ['ex-machine-home', 'ex-toast-stack'] };
    await capture.click('ex-toast button[exButton]'); await settle();
    await openMenu('local'); await capture.waitFor(() => document.querySelector('ex-machine-menu'));
    assert.equal(await capture.evaluate(() => document.querySelectorAll('ex-machine-menu button').length), 2);
    await capture.click('ex-machine-menu button:first-child'); await settle();
    assert.equal(await capture.evaluate(() => document.querySelectorAll('ex-edit-machine ex-set-value').length), 1);
    await capture.viewport(360, 740); await settle();
    yield { name: `${theme}-local-narrow`, inspect: ['ex-edit-machine'] };
    await capture.press('Escape'); await settle();
    await capture.reducedMotion(true); await openMenu(staging); await capture.waitFor(() => document.querySelector('ex-machine-menu'));
    await capture.click('ex-machine-menu button:last-child'); await capture.waitFor(id => !document.querySelector(`[data-machine="${id}"]`), staging);
    yield { name: `${theme}-reduced-removal`, inspect: ['ex-machine-home', 'ex-toast-stack'] };
    await capture.click('ex-toast button[exButton]'); await settle();
    await capture.reducedMotion(false);
  }
}
