import assert from 'node:assert/strict';

const task = '[data-task-id="11"]';
const inspect = [`${task} .earlier`, `${task} .earlier ex-ease-swap`, `${task} .earlier ex-ease-swap > span`];

// Seek only the label's live animations. Timer-driven Ticker cleanup elsewhere
// can retire debugger animation IDs while the containing batch is frozen.
async function seekLabel(capture, age) {
  await capture.evaluate(age => {
    const swap = document.querySelector('[data-task-id="11"] .earlier ex-ease-swap');
    for (const animation of swap.getAnimations({ subtree: true })) {
      if (Number.isFinite(animation.effect.getComputedTiming().endTime)) animation.currentTime = age;
    }
  }, age);
  await capture.settle();
}
async function labels(capture) {
  return capture.evaluate(() => [...document.querySelectorAll('[data-task-id="11"] .earlier ex-ease-swap > span')].map(span => ({
    text: span.textContent.trim(), leaving: span.classList.contains('leave'), hidden: span.getAttribute('aria-hidden'),
    opacity: Number(getComputedStyle(span).opacity), filter: getComputedStyle(span).filter,
  })));
}

export default async function* (capture) {
  await capture.evaluate(() => { if (location.pathname !== '/connected-workspace') location.href = '/connected-workspace'; });
  await capture.waitFor(() => document.querySelector('ex-workspace-navigation ex-task-list'));
  const owner = (fn, data) => capture.component('ex-machine-workspace', fn, data);
  const finish = async () => {
    await capture.settle();
    await capture.waitFor(() => document.getAnimations().every(animation => !Number.isFinite(animation.effect?.getComputedTiming().endTime) || animation.playState !== 'running'));
    await capture.settle();
  };
  for (const theme of ['light', 'dark']) {
    await capture.theme(theme); await capture.reducedMotion(false); await capture.viewport(1440, 1050);
    await capture.component('ex-connected-workspace-demo', component => component.fixture.busyTask());
    await owner(async component => { component.store.sessionDisclosures.set(new Map()); await component.store.selectProject('2'); await component.store.selectProject('1'); });
    await finish();
    await capture.click(`${task} .earlier-more`); await finish();
    await capture.evaluate(() => {
      document.querySelector('[data-task-id="11"] .earlier ex-ticker').dataset.identity = 'retained';
      document.querySelector('[data-task-id="11"] .earlier .outline-action').dataset.identity = 'retained';
    });
    await capture.click(`${task} .earlier-more`); await finish();
    assert.equal(await capture.evaluate(() => document.querySelector('[data-task-id="11"] .earlier ex-ticker').dataset.identity), 'retained');
    assert.equal((await labels(capture))[0].text, '2 older');
    for (const [direction, trigger, outgoing, incoming] of [
      ['to-fewer', '.earlier-more', '2 older', 'Show fewer'],
      ['to-older', '.earlier-fewer', 'Show fewer', '12 older'],
    ]) {
      await capture.motion.freeze(); await capture.click(`${task} ${trigger}`);
      await seekLabel(capture, 40);
      const early = await labels(capture);
      assert.equal(early.find(label => label.leaving)?.text, outgoing);
      assert.equal(early.find(label => label.leaving)?.hidden, 'true');
      assert.equal(early.find(label => !label.leaving)?.text, incoming);
      assert(early.find(label => label.leaving).opacity > 0 && early.find(label => label.leaving).opacity < 1);
      assert.equal(early.find(label => !label.leaving).opacity, 0);
      assert.equal(await capture.evaluate(() => document.querySelector('[data-task-id="11"] .earlier .outline-action').dataset.identity), 'retained');
      yield { name: `${theme}-${direction}-out`, inspect, metadata: { early } };
      await seekLabel(capture, 160);
      const middle = await labels(capture);
      const active = middle.find(label => !label.leaving);
      assert(active.opacity > 0 && active.opacity < 1);
      assert.notEqual(active.filter, 'none');
      yield { name: `${theme}-${direction}-in`, inspect, metadata: { middle } };
      await capture.evaluate(() => {
        for (const animation of document.querySelector('[data-task-id="11"] .earlier ex-ease-swap').getAnimations({ subtree: true })) {
          if (Number.isFinite(animation.effect.getComputedTiming().endTime)) animation.finish();
        }
      });
      await capture.motion.play(); await finish();
      assert.deepEqual((await labels(capture)).map(label => label.text), [incoming]);
      yield { name: `${theme}-${direction}-settled`, inspect };
    }
    await capture.reducedMotion(true); await capture.viewport(1000, 760);
    for (let i = 0; i < 3; i++) await capture.click(`${task} .earlier-more`);
    await finish();
    assert.deepEqual((await labels(capture)).map(label => label.text), ['Show fewer']);
    await capture.click(`${task} .earlier-fewer`); await finish();
    assert.deepEqual((await labels(capture)).map(label => label.text), ['12 older']);
    yield { name: `${theme}-narrow-reduced`, inspect };
  }
}
