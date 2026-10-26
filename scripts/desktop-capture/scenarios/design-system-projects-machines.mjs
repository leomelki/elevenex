import assert from 'node:assert/strict';

/** October 26 design contract against the production owner and supplied project preview. */
export default async function* (capture) {
  const settle = async () => {
    await capture.settle();
    await capture.waitFor(() => document.getAnimations().every(animation => !Number.isFinite(animation.effect?.getComputedTiming().endTime) || animation.playState !== 'running'));
    await capture.settle();
  };
  // Seek live DOM handles: Chromium can retire protocol animation IDs after a theme change.
  async function* frames(name, times, inspect) {
    for (const time of times) {
      await capture.evaluate(time => { for (const animation of document.getAnimations()) animation.currentTime = time; }, time);
      await capture.settle();
      yield { name: `${name}-${time}ms`, inspect, metadata: { animationTimeMs: time } };
    }
  }
  const owner = (fn, data) => capture.component('ex-machine-startup-demo', fn, data);
  const app = (fn, data) => capture.component('ex-machine-app', fn, data);
  const island = 'ex-machine-app ex-title-island .trigger';
  await capture.evaluate(() => { location.href = '/machine-startup'; });
  await capture.waitFor(() => document.querySelector('ex-machine-app [data-machine="local"]'));
  await capture.viewport(1100, 820);
  for (const theme of ['light', 'dark']) {
    await capture.theme(theme); await capture.reducedMotion(false);
    await owner(component => component.platform.reset());
    await owner(component => component.platform.setLocal({ phase: 'downloading', version: null, receivedBytes: 42, totalBytes: 100 }));
    await app(component => component.home()); await settle();
    await capture.waitFor(() => document.querySelector('ex-machine-app ex-title-island')?.textContent.includes('Getting ready 42%')); 
    await capture.motion.freeze(); await capture.click(island);
    yield* frames(`${theme}-busy-ping`, [0, 150, 420], ['[data-machine="local"]']);
    await capture.motion.finish(); await capture.motion.play();
    await capture.motion.freeze(); await owner(component => component.platform.fail());
    for (const [time, expectedX] of [[0, 0], [84, -3], [189, 3], [294, -1.5], [420, 0]]) {
      await capture.evaluate(time => { for (const animation of document.getAnimations()) animation.currentTime = time; }, time);
      await capture.settle();
      const x = await capture.evaluate(() => new window.DOMMatrixReadOnly(getComputedStyle(document.querySelector('[data-machine="local"]')).transform).m41);
      assert.ok(Math.abs(x - expectedX) < .05, `${theme} failure at ${time}ms: expected ${expectedX}px, got ${x}px`);
      yield { name: `${theme}-failure-nudge-${time}ms`, inspect: ['[data-machine="local"]'], metadata: { animationTimeMs: time, x, expectedX } };
    }
    await capture.motion.finish(); await capture.motion.play(); await settle();
    assert.match(await capture.evaluate(() => document.querySelector('ex-machine-app ex-title-island').textContent), /Couldn't download the engine/);
    assert.equal(await capture.evaluate(() => document.querySelector('[data-machine="local"] [role="progressbar"]').getAttribute('aria-valuenow')), '42');
    yield { name: `${theme}-download-error`, inspect: ['ex-machine-app ex-title-island', '[data-machine="local"]'] };
    await capture.click(island); await settle(); await capture.click('[data-machine="local"]');
    await capture.waitFor(() => document.querySelector('[data-machine="local"] .pending-tag'));
    await owner(component => component.platform.ready());
    await capture.waitFor(() => document.querySelector('.launch.open'));
    await settle(); await app(component => component.home()); await settle();
    assert.match(await capture.evaluate(() => document.querySelector('ex-machine-app ex-title-island').textContent), /Back to This Mac/);
    yield { name: `${theme}-back`, inspect: ['ex-machine-app ex-title-island', 'ex-machine-home'] };
    await capture.click(island); await capture.waitFor(() => document.querySelector('.launch.open')); await settle();
    await app(component => { component.home(); component.launcher.currentId.set(null); }); await settle();
    await capture.click(island);
    await capture.waitFor(() => document.activeElement?.getAttribute('aria-label') === 'Find a machine');
    yield { name: `${theme}-find`, inspect: ['ex-machine-home input'] }; await capture.press('Escape');
    await owner(async component => {
      const host = await component.platform.saveRemoteHost({ name: 'dev-box', host: 'dev-box' });
      await component.platform.selectEnvironment({ kind: 'remote', hostId: host.id }); component.platform.fail(true);
    }); await settle();
    assert.equal(await capture.evaluate(() => !!document.querySelector('[data-machine] .action-tag')?.closest('.danger')), true);
    assert.match(await capture.evaluate(() => document.querySelector('ex-machine-app ex-title-island').textContent), /Couldn't reach dev-box/);
    const contrast = await capture.evaluate(() => {
      const card = document.querySelector('.card.danger'), action = card.querySelector('.action-tag');
      const canvas = document.createElement('canvas'), context = canvas.getContext('2d', { willReadFrequently: true });
      const luminance = color => {
        context.fillStyle = color; context.fillRect(0, 0, 1, 1);
        const rgb = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
        return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
      };
      const ratio = (a, b) => (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
      const style = getComputedStyle(card), tag = getComputedStyle(action), background = luminance(style.backgroundColor);
      return { text: ratio(luminance(style.color), background), action: ratio(luminance(tag.color), luminance(tag.backgroundColor)), border: ratio(luminance(style.getPropertyValue('--tone')), background) };
    });
    assert.ok(contrast.text >= 4.5 && contrast.action >= 4.5 && contrast.border >= 3, JSON.stringify(contrast));
    yield { name: `${theme}-safety-error`, inspect: ['.card.danger', 'ex-machine-app ex-title-island'], metadata: { contrast } };
    await app(component => component.launcher.choose('local'));
    await capture.waitFor(() => document.querySelector('.launch.open')); await settle();
    await app(component => component.home()); await settle();
    assert.equal(await capture.evaluate(() => !!document.querySelector('.card.danger')), true);
    yield { name: `${theme}-retained-server-error`, inspect: ['.card.danger'] };
    await capture.click('.card.danger');
    await capture.waitFor(() => document.querySelector('[data-machine]:not([data-machine="local"]) .pending-tag'));
    assert.equal(await capture.evaluate(() => !!document.querySelector('.card.danger')), false);


  }
  await capture.reducedMotion(true); await capture.viewport(480, 760);
  await owner(component => { component.platform.reset(); component.platform.fail(); }); await app(component => component.home()); await settle();
  await capture.click(island);
  yield { name: 'narrow-reduced-error', inspect: ['ex-machine-home', '[data-machine="local"]'] };

  await capture.evaluate(() => { location.href = '/projects'; });
  await capture.waitFor(() => document.querySelector('ex-project-creation-demo'));
  await capture.viewport(1280, 900);
  for (const theme of ['light', 'dark']) {
    await capture.theme(theme); await capture.reducedMotion(false);
    await capture.click('#prepare-project-launch'); await settle();
    await capture.click('.over ex-new-project footer button');
    await capture.waitFor(() => !document.querySelector('.over')); await settle();
    const add = 'ex-project-creation-demo .frame ex-project-rail .add';
    await capture.motion.freeze(); await capture.click(add);
    yield* frames(`${theme}-project-modal`, [0, 240, 560], ['.ex-modal-layer .modal-card', add]);
    await capture.motion.finish(); await capture.motion.play(); await settle();
    await capture.fill('.modal-card ex-folder-suggestions input', '~/code/payments');
    await capture.waitFor(() => document.querySelector('[role="option"][id^="folders-"]'));
    await capture.click('[role="option"][id^="folders-"]'); await settle();
    await capture.click('.modal-card ex-new-project footer button'); await settle();
    await capture.fill('.modal-card input[aria-label="Project name"]', 'Payments');
    await capture.click('.modal-card ex-new-project footer button'); await settle();
    await capture.motion.freeze(); await capture.click('.modal-card ex-new-project footer button');
    assert.equal(await capture.evaluate(() => document.querySelector('.ex-modal-layer')?.classList.contains('ex-modal-has-from')), false);
    assert.equal(await capture.evaluate(() => document.querySelector('ex-project-rail [aria-current="true"]')?.getAttribute('aria-label')), 'Payments');
    yield* frames(`${theme}-project-added`, [0, 140, 300, 760], ['ex-project-rail', '.ex-modal-layer']);
    await capture.motion.finish(); await capture.motion.play(); await settle();
    assert.equal(await capture.evaluate(() => document.querySelectorAll('.ex-modal-layer').length), 0);
    assert.equal(await capture.evaluate(() => document.querySelector('ex-project-creation-demo .side-name').textContent), 'Payments');
    await capture.click(add); await settle(); await capture.press('Escape'); await settle();
    assert.equal(await capture.evaluate(() => document.activeElement?.classList.contains('add')), true);
    yield { name: `${theme}-project-cancelled`, inspect: ['ex-project-rail'] };
  }
}
