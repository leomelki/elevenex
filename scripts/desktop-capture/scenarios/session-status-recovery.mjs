import assert from 'node:assert/strict';

/** Existing conversations must never become dotted merely for being idle. */
export default async function* (capture) {
  await capture.evaluate(() => { location.href = '/connected-workspace'; });
  await capture.waitFor(() => document.querySelector('ex-workspace-navigation ex-task-list'));
  await capture.cdp('Emulation.setFocusEmulationEnabled', { enabled: true });
  const inspect = ['ex-workspace-navigation', 'ex-session-row', 'ex-status-summary', 'ex-session-chat'];
  for (const theme of ['light', 'dark']) {
    await capture.theme(theme);
    for (const narrow of [false, true]) {
      await capture.viewport(narrow ? 980 : 1440, 900);
      await capture.reducedMotion(narrow);
      await capture.component('ex-machine-workspace', c => c.store.selectSession({ taskId: '11', sessionId: '101' }));
      await capture.component('ex-connected-workspace-demo', c => c.fixture.legacySessionActivity());
      await capture.component('ex-machine-workspace', async c => {
        await c.store.refresh(); c.store.selectSession({ taskId: '11', sessionId: '101' });
      });
      await capture.waitFor(() => document.querySelector('[data-session-id="105"] [data-status="running"]'));
      await capture.waitFor(() => document.querySelectorAll('ex-task-group article').length === 1);
      await capture.waitFor(() => document.getAnimations().every(animation => !Number.isFinite(animation.effect?.getComputedTiming().endTime) || animation.playState !== 'running'));
      const statuses = () => capture.evaluate(() => Object.fromEntries(
        [...document.querySelectorAll('article[data-task-id="11"] ex-session-row [data-session-id]')].map(row => [
          row.getAttribute('data-session-id'), row.querySelector('[data-status]')?.getAttribute('data-status'),
        ]),
      ));
      const expected = { 101: 'done', 102: 'done', 103: 'review', 104: 'queued', 105: 'running' };
      assert.deepEqual(await statuses(), expected);
      const rows = await capture.evaluate(() => [...document.querySelectorAll('article[data-task-id="11"] ex-session-row .row')].map(row => ({ id: row.dataset.sessionId, top: row.getBoundingClientRect().top })));
      yield { name: `${theme}-${narrow ? 'narrow-reduced' : 'desktop'}-recovered`, inspect, metadata: { statuses: expected } };
      // Refresh and reopening the same historical chat must preserve its state.
      await capture.component('ex-machine-workspace', async c => {
        await c.store.refresh(); c.store.selectSession({ taskId: '11', sessionId: '102' });
      });
      assert.deepEqual(await statuses(), expected);
      await capture.evaluate(() => document.querySelector('[data-session-id="103"] button.select').focus());
      await capture.press('Enter');
      await capture.waitFor(() => document.querySelector('[data-session-id="103"] [data-status="done"]'));
      await capture.waitFor(() => document.getAnimations().every(animation => !Number.isFinite(animation.effect?.getComputedTiming().endTime) || animation.playState !== 'running'));
      assert.deepEqual(await statuses(), { ...expected, 103: 'done' });
      assert.deepEqual(await capture.evaluate(() => [...document.querySelectorAll('article[data-task-id="11"] ex-session-row .row')].map(row => ({ id: row.dataset.sessionId, top: row.getBoundingClientRect().top }))), rows);
      yield { name: `${theme}-${narrow ? 'narrow-reduced' : 'desktop'}-viewed`, inspect };
    }
  }
}
