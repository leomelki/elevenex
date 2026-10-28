import assert from 'node:assert/strict';

function metricsDelta(before, after) {
  return Object.fromEntries(after.metrics.filter(metric =>
    ['LayoutCount', 'RecalcStyleCount', 'LayoutDuration', 'RecalcStyleDuration', 'ScriptDuration', 'TaskDuration'].includes(metric.name),
  ).map(metric => [metric.name, metric.value - before.metrics.find(previous => previous.name === metric.name).value]));
}

async function startSample(capture) {
  const before = await capture.cdp('Performance.getMetrics');
  await capture.evaluate(() => {
    const sample = window.statusMotionSample = { started: performance.now(), intervals: [], longFrames: [], done: false };
    let previous;
    const observer = new window.PerformanceObserver(list => {
      for (const entry of list.getEntries()) if (entry.startTime + entry.duration > sample.started && sample.longFrames.length < 20) {
        sample.longFrames.push({ duration: entry.duration, blockingDuration: entry.blockingDuration });
      }
    });
    observer.observe({ type: 'long-animation-frame' });
    const frame = now => {
      if (previous === undefined) sample.firstFrameDelay = now - sample.started;
      else sample.intervals.push(now - previous);
      previous = now;
      if (now - sample.started < 1000) requestAnimationFrame(frame);
      else { observer.disconnect(); sample.done = true; }
    };
    requestAnimationFrame(frame);
  });
  return before;
}

async function finishSample(capture, before) {
  await capture.waitFor(() => window.statusMotionSample.done);
  const after = await capture.cdp('Performance.getMetrics');
  const sample = await capture.evaluate(() => window.statusMotionSample);
  return { ...sample, longestFrameInterval: Math.max(...sample.intervals), metrics: metricsDelta(before, after) };
}

/** Live native performance regression, with the production owner and bounded preview data. */
export default async function* (capture) {
  // No scrubbing: measure Chromium's normal animation path, including the compositor.
  await capture.cdp('Animation.disable');
  await capture.cdp('Performance.enable');
  for (const theme of ['light', 'dark']) {
    await capture.theme(theme); await capture.viewport(1440, 960); await capture.reducedMotion(false);
    await capture.evaluate(() => { location.href = '/connected-workspace'; });
    await capture.waitFor(() => document.querySelector('ex-workspace-navigation ex-task-list'));
    await capture.component('ex-connected-workspace-demo', component => component.fixture.sidebarState('many'));
    await capture.component('ex-machine-workspace', component => component.store.refresh());
    await capture.waitFor(() => document.querySelector('[data-task-id="30"]'));
    await capture.motion.finish(); await capture.settle();

    const running = await capture.evaluate(() => {
      const animations = document.getAnimations().filter(animation =>
        animation.effect?.getTiming().iterations === Infinity && animation.effect.target?.closest('ex-status-glyph'));
      return { count: animations.length, htmlSurfaces: animations.every(animation => animation.effect.target instanceof window.HTMLElement) };
    });
    assert.ok(running.count >= 30, 'Exercise the populated sidebar, not an empty animation sample');
    assert.equal(running.htmlSurfaces, true, 'Continuous status rotation must avoid SVG layout');
    // An rAF probe would itself request main-thread frames throughout this idle
    // interval. Let compositor-only indicators run without that measurement work.
    const beforeIdle = await capture.cdp('Performance.getMetrics');
    await capture.evaluate(() => new Promise(resolve => setTimeout(resolve, 1000)));
    const idle = { metrics: metricsDelta(beforeIdle, await capture.cdp('Performance.getMetrics')) };
    // Counts test rendering work, not a hardware-dependent frame-rate promise.
    // A few initial viewport/font observations are allowed; per-frame SVG layout is not.
    assert.ok(idle.metrics.LayoutCount <= 2, `Idle status indicators triggered ${idle.metrics.LayoutCount} layouts`);
    yield { name: `${theme}-busy-sidebar-idle`, metadata: { running, idle }, inspect: ['ex-workspace-navigation'] };

    for (const phase of ['first', 'warm']) {
      const before = await startSample(capture);
      await capture.click('ex-workspace-navigation [aria-label="New task"]');
      await capture.waitFor(() => document.querySelector('input[aria-label="Task name"]'));
      const sample = await finishSample(capture, before);
      yield { name: `${theme}-${phase}-dialog`, metadata: sample, inspect: ['.ex-modal-layer', 'ex-new-task'] };
      await capture.press('Escape');
      await capture.waitFor(() => !document.querySelector('.ex-modal-layer'));
      assert.equal(await capture.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'New task');
    }

    await capture.reducedMotion(true); await capture.viewport(480, 760); await capture.settle();
    assert.equal(await capture.evaluate(() => document.getAnimations().some(animation =>
      animation.effect?.getTiming().iterations === Infinity && animation.effect.target?.closest('ex-status-glyph'))), false);
    yield { name: `${theme}-reduced-narrow`, inspect: ['ex-workspace-navigation'] };
    await capture.component('ex-connected-workspace-demo', component => component.fixture.empty());
    await capture.waitFor(() => document.querySelector('ex-workspace-onboarding'));
    assert.equal(await capture.evaluate(() => document.getAnimations().some(animation =>
      animation.effect?.target?.closest('ex-status-glyph'))), false, 'Removed status indicators release their animations');
  }
}
