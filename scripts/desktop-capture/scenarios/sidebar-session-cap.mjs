import assert from 'node:assert/strict';

const task = '[data-task-id="11"]';
const inspect = [task, `${task} .earlier`, `${task} ex-session-batch`, `${task} .muted .title`];

// Sample before trusted input, through the last cleanup frame. This catches a
// one-frame flash that an animation-only midpoint or a post-click probe misses.
async function startProbe(capture) {
  await capture.evaluate(() => {
    const host = document.querySelector('[data-task-id="11"]');
    const target = host.querySelector('[data-session-id="214"] .select');
    const samples = [];
    const leaks = [];
    const watched = new WeakSet();
    const start = performance.now();
    const checkClipping = batch => {
      if (!batch.isConnected || batch.getAttribute('aria-hidden') !== 'true') return;
      const height = batch.getBoundingClientRect().height;
      const contentHeight = batch.firstElementChild.getBoundingClientRect().height;
      const overflow = getComputedStyle(batch).overflowY;
      if (contentHeight > height + 1 && !['hidden', 'clip'].includes(overflow)) {
        leaks.push({ time: performance.now() - start, height, contentHeight, overflow });
      }
    };
    const snapshot = () => {
      for (const batch of host.querySelectorAll('ex-session-batch')) {
        checkClipping(batch);
        for (const animation of batch.getAnimations()) {
          if (watched.has(animation)) continue;
          watched.add(animation);
          // The finish callback runs before Angular removes the retained batch.
          // Sample that boundary as well as painted frames.
          animation.addEventListener('finish', () => checkClipping(batch), { once: true });
        }
      }
      samples.push({ time: performance.now() - start, y: target.getBoundingClientRect().y,
        moving: host.querySelectorAll('ex-session-batch.moving').length });
    };
    snapshot();
    host.capProbe = new Promise(resolve => {
      const frame = () => {
        snapshot();
        if (performance.now() - start < 1200) requestAnimationFrame(frame);
        else resolve({ samples, leaks });
      };
      requestAnimationFrame(frame);
    });
  });
}
async function endProbe(capture, limit) {
  const { samples, leaks } = await capture.evaluate(async () => {
    const host = document.querySelector('[data-task-id="11"]');
    const samples = await host.capProbe;
    delete host.capProbe;
    return samples;
  });
  assert.deepEqual(leaks, [], 'closing rows stay clipped through animation completion and DOM removal');
  let maxStep = 0, maxSpeed = 0, maxInterval = 0, fastest;
  for (let i = 1; i < samples.length; i++) {
    const dt = samples[i].time - samples[i - 1].time;
    const dy = Math.abs(samples[i].y - samples[i - 1].y);
    maxStep = Math.max(maxStep, dy);
    maxInterval = Math.max(maxInterval, dt);
    // The initial snapshot can land between paints; speed needs two rAF samples.
    if (i > 1 && dt > 4 && dy * 16.67 / dt > maxSpeed) { maxSpeed = dy * 16.67 / dt; fastest = samples.slice(Math.max(0, i - 2), i + 2); }
  }
  assert(samples.some(sample => sample.moving), 'batch scroll must run');
  assert(maxSpeed < limit, `scroll speed ${maxSpeed.toFixed(2)}px per 60Hz frame exceeds ${limit}: ${JSON.stringify(fastest)}`);
  assert(maxStep < limit * Math.max(16.67, maxInterval) / 16.67 + 1, 'no boundary-frame jump');
  assert.equal(samples.at(-1).moving, 0, 'scroll releases masking and clipping');
  return { maxStep, maxSpeed, maxInterval, frames: samples.length };
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
  const visible = () => capture.evaluate(() => [...document.querySelectorAll('[data-task-id="11"] ex-session-row .row')].filter(row => !row.closest('[inert]')).map(row => row.dataset.sessionId));
  for (const theme of ['light', 'dark']) {
    await capture.theme(theme); await capture.reducedMotion(false); await capture.viewport(1440, 1050);
    await capture.component('ex-connected-workspace-demo', component => component.fixture.busyTask());
    await owner(async component => { component.store.sessionDisclosures.set(new Map()); await component.store.selectProject('2'); await component.store.selectProject('1'); });
    await finish();
    assert.equal(await capture.evaluate(() => document.querySelector('[data-task-id="11"] .earlier-more').getAttribute('aria-label')), 'Show 5 older sessions (12 hidden)');
    // A needs-you row at the boundary keeps its normal title color.
    assert.equal(await capture.evaluate(() => document.querySelectorAll('[data-task-id="11"] .muted').length), 0);
    yield { name: `${theme}-cap`, inspect };
    await startProbe(capture);
    await capture.click(`${task} .earlier-more`);
    const opening = await endProbe(capture, 18);
    await finish();
    assert.equal((await visible()).length, 12);
    assert.equal(await capture.evaluate(() => document.querySelector('[data-task-id="11"] .muted').closest('[data-session-id]').dataset.sessionId), '209');
    await capture.press('Tab'); await capture.press('Tab', 8);
    assert.equal(await capture.evaluate(() => document.activeElement?.classList.contains('earlier-more')), true);
    assert.notEqual(await capture.evaluate(() => getComputedStyle(document.activeElement).boxShadow), 'none');
    assert.equal(await capture.evaluate(() => {
      const host = document.querySelector('[data-task-id="11"]');
      const title = getComputedStyle(host.querySelector('.muted .title'));
      return title.color === getComputedStyle(host.querySelector('header .chevron')).color && title.opacity === '1';
    }), true);
    assert.equal(await capture.evaluate(() => {
      const style = getComputedStyle(document.querySelector('[data-task-id="11"] ex-session-batch'));
      return style.maskImage === 'none' && style.overflow === 'visible';
    }), true);
    yield { name: `${theme}-opening`, inspect, metadata: { opening } };
    // Selection is controlled by the real owner. Its row and batch must survive.
    await capture.evaluate(() => {
      const row = document.querySelector('[data-task-id="11"] ex-session-batch [data-session-id="209"]');
      row.dataset.identity = 'retained';
    });
    await capture.click(`${task} [data-session-id="209"] .select`); await finish();
    assert.equal(await capture.evaluate(() => document.querySelector('[data-task-id="11"] ex-session-batch [data-session-id="209"]').dataset.identity), 'retained');
    assert.equal(await capture.evaluate(() => document.querySelectorAll('[data-task-id="11"] .muted').length), 0);
    yield { name: `${theme}-selected-in-batch`, inspect };
    await capture.click(`${task} .earlier-fewer`); await finish();
    assert((await visible()).includes('209'));
    assert.equal(await capture.evaluate(() => document.querySelector('[data-task-id="11"] ex-session-batch')), null);
    yield { name: `${theme}-selected-after-fewer`, inspect };
    // Reset selection before measuring a two-batch close.
    await owner(component => component.store.selectProject('2')); await finish();
    await owner(component => { component.store.sessionDisclosures.set(new Map()); return component.store.selectProject('1'); }); await finish();
    await capture.click(`${task} .earlier-more`); await finish();
    await capture.click(`${task} .earlier-more`); await finish();
    await startProbe(capture); await capture.click(`${task} .earlier-fewer`);
    const closing = await endProbe(capture, 26); await finish();
    yield { name: `${theme}-closing-ten`, inspect, metadata: { closing } };
    await capture.click(`${task} .earlier-more`); await finish();
    await capture.click(`${task} .earlier-fewer`);
    await capture.waitFor(() => {
      const height = document.querySelector('[data-task-id="11"] ex-session-batch')?.getBoundingClientRect().height;
      return height > 30 && height < 100;
    });
    await startProbe(capture);
    const beforeReverse = await capture.evaluate(() => document.querySelector('[data-task-id="11"] ex-session-batch').getBoundingClientRect().height);
    await capture.click(`${task} .earlier-more`);
    const reversal = await endProbe(capture, 18); await finish();
    assert(beforeReverse > 0 && beforeReverse < 140);
    assert.equal(await capture.evaluate(() => document.querySelector('[data-task-id="11"] ex-session-batch').getBoundingClientRect().height), 140);
    yield { name: `${theme}-reversed`, inspect, metadata: { beforeReverse, reversal } };
    await capture.click(`${task} .earlier-fewer`); await finish();
    await capture.click(`${task} .earlier-more`);
    await capture.reducedMotion(true); await capture.viewport(1000, 760); await finish();
    assert.equal(await capture.evaluate(() => document.querySelectorAll('[data-task-id="11"] ex-session-batch.moving').length), 0);
    yield { name: `${theme}-narrow-reduced`, inspect };
    await capture.click(`${task} .earlier-fewer`); await finish();
  }
}
