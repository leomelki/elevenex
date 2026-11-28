import assert from 'node:assert/strict';

// Record before input: a probe started after click misses first-use stalls.
async function startProbe(capture) {
  await capture.evaluate(() => {
    const launch = document.querySelector('ex-machine-launch .launch');
    const probe = window.firstOpenProbe = { intervals: [], longFrames: [], workspaceAtOpen: false, done: false };
    let previous;
    const observer = new window.MutationObserver(() => {
      if (launch.classList.contains('open') && probe.opened === undefined) {
        probe.opened = performance.now();
        probe.workspaceAtOpen = !!document.querySelector('ex-machine-workspace ex-app-shell');
      }
    });
    observer.observe(launch, { attributes: true });
    const longFrames = new window.PerformanceObserver(list => {
      for (const entry of list.getEntries()) if (entry.startTime >= probe.opened && entry.startTime < probe.opened + 600) {
        probe.longFrames.push({ duration: entry.duration, blockingDuration: entry.blockingDuration });
      }
    });
    longFrames.observe({ type: 'long-animation-frame' });
    const sample = now => {
      if (probe.opened !== undefined && previous !== undefined) probe.intervals.push(now - previous);
      previous = now;
      if (probe.opened === undefined || now - probe.opened < 600) requestAnimationFrame(sample);
      else {
        observer.disconnect(); longFrames.disconnect(); probe.done = true;
      }
    };
    requestAnimationFrame(sample);
  });
}

async function opening(capture) {
  await capture.waitFor(() => window.firstOpenProbe.done);
  const probe = await capture.evaluate(() => window.firstOpenProbe);
  assert.equal(probe.workspaceAtOpen, true, 'First-use workspace creation precedes launch');
  assert.ok(probe.intervals.length > 0);
  // Frame times are diagnostics, not a hardware-independent FPS guarantee.
  return { ...probe, longestFrameInterval: Math.max(...probe.intervals) };
}

/** Native Electron, production composition, isolated backend replies. */
export default async function* (capture) {
  for (const theme of ['light', 'dark']) {
    await capture.evaluate(() => { location.href = '/machine-startup'; });
    await capture.waitFor(() => document.querySelector('[data-machine="local"]'));
    await capture.theme(theme); await capture.viewport(1100, 820);
    // Cover a ready backend too: there is no 450ms preparation beat to hide mounting.
    if (theme === 'dark') await capture.component('ex-machine-startup-demo', component => component.platform.ready());
    await capture.settle();
    assert.equal(await capture.evaluate(() => !!document.querySelector('ex-machine-workspace')), false, 'Idle prefetch must not mount a workspace');
    await startProbe(capture);
    await capture.click('[data-machine="local"]');
    if (theme === 'light') {
      await capture.waitFor(() => document.querySelector('ex-machine-workspace ex-app-shell'));
      assert.equal(await capture.evaluate(() => document.querySelector('ex-machine-workspace').hasAttribute('inert')), true);
      assert.equal(await capture.evaluate(() => !!document.activeElement?.closest('ex-machine-workspace')), false, 'Preparation cannot take focus from Home');
      yield { name: `${theme}-workspace-preparing`, inspect: ['ex-machine-home', 'ex-machine-workspace'] };
      // No render between cancellation and reselection: the prior candidate's
      // DOM can still exist, but its readiness must belong to the new lifetime.
      await capture.component('ex-machine-app', async component => {
        component.home(); await component.launcher.choose('local');
      });
      await capture.component('ex-machine-startup-demo', component => component.platform.ready());
    }
    const first = await opening(capture);
    await capture.waitFor(() => !document.querySelector('.launch .faces')?.childElementCount);
    yield { name: `${theme}-first-launch`, inspect: ['ex-machine-workspace', 'ex-title-island'], metadata: first };
    await capture.component('ex-machine-app', component => component.home());
    await capture.waitFor(() => !document.querySelector('.launch .faces')?.childElementCount);
    await startProbe(capture);
    await capture.click('[data-machine="local"]');
    const warm = await opening(capture);
    yield { name: `${theme}-warm-launch`, metadata: warm };

    // Return during motion, then reopen with native keyboard input.
    await capture.component('ex-machine-app', component => component.home());
    await capture.component('ex-machine-app', component => component.launcher.choose('local'));
    await capture.waitFor(() => document.querySelector('.launch.open'));
    await capture.waitFor(() => !document.querySelector('.launch .faces')?.childElementCount);
    await capture.component('ex-machine-app', component => component.home());
    await capture.waitFor(() => !document.querySelector('.launch .faces')?.childElementCount);
    await capture.reducedMotion(true); await capture.viewport(480, 760);
    await capture.evaluate(() => document.querySelector('[data-machine="local"]').focus());
    await capture.press('Enter');
    await capture.waitFor(() => document.querySelector('.launch.open'));
    await capture.waitFor(() => !document.querySelector('.launch .faces')?.childElementCount);
    assert.equal(await capture.evaluate(() => !!document.activeElement?.closest('.launch .pane')), true);
    yield { name: `${theme}-narrow-reduced-launch`, inspect: ['ex-machine-workspace'] };
    await capture.reducedMotion(false);
  }
}
