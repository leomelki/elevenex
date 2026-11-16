import assert from 'node:assert/strict';

/** Permanent removal is available only for an engine-confirmed unused session. */
export default async function* (capture) {
  await capture.evaluate(() => { location.href = '/connected-workspace'; });
  await capture.waitFor(() => document.querySelector('ex-workspace-navigation ex-task-list'));
  await capture.cdp('Emulation.setFocusEmulationEnabled', { enabled: true });
  const inspect = ['ex-workspace-navigation', 'ex-session-row', 'ex-session-chat'];
  for (const theme of ['light', 'dark']) {
    await capture.theme(theme);
    for (const narrow of [false, true]) {
      await capture.viewport(narrow ? 980 : 1440, 900);
      await capture.reducedMotion(narrow);
      await capture.component('ex-connected-workspace-demo', c => c.fixture.legacySessionActivity());
      await capture.component('ex-machine-workspace', async c => {
        await c.store.refresh(); c.store.selectSession({ taskId: '11', sessionId: '104' });
      });
      await capture.waitFor(() => document.querySelector('[data-session-id="104"] [aria-label="Delete New conversation"]'));
      await capture.waitFor(() => document.getAnimations().every(animation => !Number.isFinite(animation.effect?.getComputedTiming().endTime) || animation.playState !== 'running'));
      assert.equal(await capture.evaluate(() => document.querySelector('[data-session-id="104"] [aria-label="Archive New conversation"]') !== null), false);
      assert.equal(await capture.evaluate(() => document.querySelector('[data-session-id="101"] [aria-label^="Archive "]') !== null), true);
      await capture.evaluate(() => document.querySelector('[data-session-id="104"] button.archive').focus());
      const state = `${theme}-${narrow ? 'narrow-reduced' : 'desktop'}`;
      yield { name: `${state}-delete`, inspect };
      await capture.press('Enter');
      await capture.waitFor(() => !document.querySelector('[data-session-id="104"]'));
      await capture.component('ex-machine-workspace', c => {
        if (c.store.selected()?.sessionId !== 105) throw new Error('Deletion did not select the next session');
        if (c.store.sessionArchiveUndo()) throw new Error('Deletion created an archive Undo');
      });
      await capture.waitFor(() => document.activeElement?.closest('[data-session-id="105"]'));
      await capture.component('ex-machine-workspace', c => c.store.refresh());
      assert.equal(await capture.evaluate(() => document.querySelector('[data-session-id="104"]') !== null), false);
      yield { name: `${state}-deleted`, inspect };
      await capture.click('[data-session-id="105"] button.archive');
      await capture.waitFor(() => document.querySelector('[data-session-id="105"] [aria-label*="press again to confirm"]'));
      yield { name: `${state}-running-archive`, inspect };
      await capture.press('Escape');
      await capture.waitFor(() => !document.querySelector('[data-session-id="105"] [aria-label*="press again to confirm"]'));
    }
  }
}
