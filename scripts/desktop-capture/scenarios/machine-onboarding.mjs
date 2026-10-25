import assert from 'node:assert/strict';

// Real renderer components with isolated preview data: --url http://127.0.0.1:4310.
export default async function* (capture) {
  await capture.evaluate(() => { location.href = '/machine-flow'; });
  await capture.waitFor(() => !!document.querySelector('ex-machine-flow-demo'));
  const owner = (fn, data) => capture.component('ex-machine-flow-demo', fn, data);
  const settled = () => capture.evaluate(async () => {
    await Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => undefined)));
  });
  const compactStatus = async () => {
    await settled();
    const geometry = await capture.evaluate(() => {
      const bar = document.querySelector('ex-machine-flow-demo ex-title-bar').getBoundingClientRect();
      const island = document.querySelector('ex-machine-flow-demo ex-title-island .island');
      const box = island.getBoundingClientRect(), summary = getComputedStyle(island.querySelector('.summary'));
      return { height: box.height, barHeight: bar.height, top: box.top - bar.top, bottom: bar.bottom - box.bottom, paddingLeft: summary.paddingLeft, paddingRight: summary.paddingRight, gap: summary.gap, iconSize: island.querySelector('svg').getBoundingClientRect().width, text: island.textContent.trim(), tone: island.dataset.tone, progress: island.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow') };
    });
    assert.equal(geometry.height, 24); assert.equal(geometry.barHeight, 34);
    assert.equal(geometry.top, 5); assert.equal(geometry.bottom, 5);
    assert.equal(geometry.paddingLeft, '12px'); assert.equal(geometry.paddingRight, '12px');
    assert.equal(geometry.gap, '7px'); assert.equal(geometry.iconSize, 13);
    assert.equal(geometry.tone, 'info');
    return geometry;
  };
  // Native button activation needs Enter's text/code as well as its key name.
  const enter = async () => {
    await capture.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' });
    await capture.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await capture.settle();
  };
  for (const theme of ['light', 'dark']) {
    await capture.theme(theme);
    await capture.reducedMotion(false);
    await owner(component => component.reset(true));
    await settled();
    assert.equal(await capture.evaluate(() => getComputedStyle(document.querySelector('.launch > .pane')).opacity), '0');
    yield { name: `${theme}-first-run`, inspect: ['ex-machine-home', '.launch > .pane', '[data-machine]'], metadata: { island: await compactStatus() } };
    await capture.click('[data-machine="local"]');
    assert.equal(await capture.evaluate(() => document.querySelector('[data-machine="local"]').textContent.includes('Will open')), true);
    yield { name: `${theme}-local-pending`, metadata: { island: await compactStatus() } };
    await capture.click('ex-machine-add[kind="ssh"] button');
    await capture.waitFor(() => !!document.querySelector('ex-add-machine input'));
    await settled();
    assert.equal(await capture.evaluate(() => document.querySelector('ex-add-machine footer button:last-child').disabled), true);
    yield { name: `${theme}-ssh-empty`, inspect: ['ex-add-machine', 'ex-host-field .field', 'ex-add-machine footer'] };
    await capture.fill('ex-host-field input', 'dev'); await enter();
    await capture.waitFor(() => !!document.querySelector('ex-host-field dl')); await settled();
    yield { name: `${theme}-ssh-picked` };
    await enter();
    await capture.waitFor(() => !!document.querySelector('ex-host-key-check') && document.activeElement === document.querySelector('ex-add-machine footer button:last-child'));
    await settled();
    yield { name: `${theme}-ssh-key`, inspect: ['ex-add-machine', 'ex-host-key-check', 'ex-add-machine footer'] };
    await capture.click('ex-add-machine footer button:first-child');
    await capture.waitFor(() => !!document.querySelector('ex-host-field input')); await settled();
    await capture.evaluate(() => document.querySelector('ex-host-field input').focus()); await enter();
    await capture.waitFor(() => !!document.querySelector('ex-host-key-check') && document.activeElement === document.querySelector('ex-add-machine footer button:last-child'));
    await enter();
    await capture.waitFor(() => !document.querySelector('.ex-modal-layer'));
    await capture.waitFor(() => document.querySelectorAll('[data-machine]').length === 2); await settled();
    yield { name: `${theme}-server-preparing`, inspect: ['ex-machine-home', '[data-machine]'], metadata: { island: await compactStatus() } };
    await capture.click('#ready-machine');
    await capture.waitFor(() => document.querySelector('.launch').classList.contains('open'));
    await capture.waitFor(() => !document.querySelector('.launch .faces').children.length); await settled();
    yield { name: `${theme}-launched-new-project`, inspect: ['.launch > .pane', '.launch > .pane > .zoom', 'ex-new-project'] };
    await capture.waitFor(() => document.activeElement.closest('ex-new-project') !== null);
    await capture.click('#update-machine');
    await capture.waitFor(() => !!document.querySelector('.update-screen ex-getting-ready'));
    assert.equal(await capture.evaluate(() => !!document.querySelector('.machine-view .project-background')), false);
    yield { name: `${theme}-update-open-machine`, metadata: { island: await compactStatus() } };
    await capture.click('#change-machine');
    await capture.waitFor(() => !document.querySelector('.launch .faces').children.length); await settled();
    yield { name: `${theme}-return-home`, inspect: ['ex-machine-home', '[data-machine]'] };
    await capture.click('ex-machine-home footer button:last-child');
    await capture.waitFor(() => !!document.querySelector('ex-pair-paste textarea')); await settled();
    yield { name: `${theme}-pair-empty` };
    await capture.fill('ex-pair-paste textarea', 'invalid');
    await capture.waitFor(() => !!document.querySelector('ex-add-machine [role="alert"]'));
    yield { name: `${theme}-pair-error` };
    await capture.fill('ex-pair-paste textarea', 'elx-pair:v1:preview-only');
    assert.equal(await capture.evaluate(() => document.querySelector('ex-add-machine footer button:last-child').disabled), true);
    await capture.waitFor(() => !!document.querySelector('ex-pair-paste .found')); await settled();
    yield { name: `${theme}-pair-found` };
    await capture.click('ex-add-machine footer button:last-child');
    await capture.waitFor(() => !document.querySelector('.ex-modal-layer')); await settled();
    yield { name: `${theme}-peer-preparing` };
    await capture.click('#fail-machine'); await settled();
    yield { name: `${theme}-failed-card` };
    await capture.click('#later-run'); await settled();
    yield { name: `${theme}-later-visit` };
    await capture.click('[data-machine="mini"]'); await capture.click('[data-machine="build"]'); await capture.click('#ready-machine');
    await capture.waitFor(() => document.querySelector('.launch').classList.contains('open'));
    await capture.waitFor(() => !document.querySelector('.launch .faces').children.length);
    assert.equal(await capture.evaluate(() => document.querySelector('ex-new-project').textContent.includes('build-arm64')), true);
    yield { name: `${theme}-last-selection-wins` };
    await owner(component => component.reset(false)); await settled();
    await capture.fill('ex-machine-home input[type="search"]', 'no-such-machine');
    yield { name: `${theme}-no-matches` };
    await capture.fill('ex-machine-home input[type="search"]', '');
    await owner(component => { component.reset(false); component.machines.set([]); }); await settled();
    yield { name: `${theme}-empty-home` };
    await capture.reducedMotion(true); await owner(component => component.reset(false));
    await capture.click('[data-machine="local"]');
    await capture.waitFor(() => !document.querySelector('.launch .faces').children.length); await settled();
    yield { name: `${theme}-reduced-launch` };
  }
  await owner(component => component.reset(true));
  await settled();
  await capture.viewport(560, 900);
  await capture.evaluate(() => document.querySelector('ex-machine-add[kind="peer"] button').scrollIntoView({ block: 'center' }));
  await capture.click('ex-machine-add[kind="peer"] button');
  await capture.waitFor(() => !!document.querySelector('ex-pair-paste textarea')); await settled();
  yield { name: 'narrow-pair-dialog', inspect: ['ex-add-machine', '.ex-modal-layer'] };
  await capture.press('Escape'); await capture.waitFor(() => !document.querySelector('.ex-modal-layer'));
  assert.equal(await capture.evaluate(() => document.activeElement.closest('ex-machine-add') !== null), true);
  yield { name: 'narrow-restored-focus' };
}
