import assert from 'node:assert/strict';

/** Exercise event-driven status through the real store/observer, with no manual
 * refresh after setup. The isolated fixture implements the cancellable wait. */
export default async function* (capture) {
  await capture.evaluate(() => { location.href = '/connected-workspace'; });
  await capture.waitFor(() => document.querySelector('ex-workspace-navigation ex-task-list'));
  await capture.cdp('Emulation.setFocusEmulationEnabled', { enabled: true });
  await capture.component('ex-connected-workspace-demo', c => c.fixture.legacySessionActivity());
  await capture.component('ex-machine-workspace', c => c.store.refresh());
  await capture.component('ex-connected-workspace-demo', c => c.fixture.liveSessionStatus(102, 'queued'));
  // Focus forces capability discovery without waiting for the older poll cadence.
  await capture.evaluate(() => window.dispatchEvent(new window.Event('focus')));
  await capture.waitFor(() => document.querySelector('[data-session-id="102"] [data-status="queued"]'));
  for (const theme of ['light', 'dark']) {
    await capture.theme(theme);
    for (const narrow of [false, true]) {
      await capture.viewport(narrow ? 980 : 1440, 900);
      await capture.reducedMotion(narrow);
      for (const status of ['running', 'attention', 'failed', 'queued', 'review', 'done']) {
        const started = Date.now();
        await capture.component('ex-connected-workspace-demo', (c, next) => c.fixture.liveSessionStatus(102, next), status);
        await capture.waitFor(next => document.querySelector(`[data-session-id="102"] [data-status="${next}"]`), status);
        const elapsed = Date.now() - started;
        assert.ok(elapsed < 1500, `${status} took ${elapsed}ms`);
        await capture.waitFor(() => document.getAnimations().every(animation => !Number.isFinite(animation.effect?.getComputedTiming().endTime) || animation.playState !== 'running'));
        yield { name: `${theme}-${narrow ? 'narrow-reduced' : 'desktop'}-${status}`, inspect: ['ex-workspace-navigation', '[data-session-id="102"]', 'ex-status-summary'], metadata: { status, elapsedMs: elapsed } };
      }
      await capture.evaluate(() => document.querySelector('[data-session-id="102"] button.select').focus());
      // Interrupted transitions must settle on the latest authoritative state.
      await capture.component('ex-connected-workspace-demo', c => {
        c.fixture.liveSessionStatus(102, 'running');
        c.fixture.liveSessionStatus(102, 'attention');
        c.fixture.liveSessionStatus(102, 'done');
      });
      await capture.waitFor(() => document.querySelector('[data-session-id="102"] [data-status="done"]'));
      assert.equal(await capture.evaluate(() => document.activeElement?.closest('[data-session-id]')?.getAttribute('data-session-id')), '102');
    }
  }
}
