import assert from 'node:assert/strict';

/** Exercise optimistic → saved queue receipts through the production chat owner. */
export default async function* (capture) {
  await capture.evaluate(() => { location.href = '/connected-workspace'; });
  await capture.waitFor(() => document.querySelector('ex-workspace-navigation ex-task-list'));
  await capture.component('ex-machine-workspace', component => component.store.selectSession({ taskId: '11', sessionId: '101' }));
  await capture.waitFor(() => document.querySelector('ex-composer textarea'));
  // Delay only the preview adapter, so Chromium paints the optimistic row before
  // the real store reconciles the receipt. No production hook is involved.
  await capture.component('ex-connected-workspace-demo', component => {
    component.fixture.sessionChatCommand = async (scope, input) => {
      if (input.action.type === 'send' && input.action.queue)
        await new Promise(resolve => setTimeout(resolve, 180));
      return component.fixture.chat.command(input);
    };
  });
  const queue = 'ex-composer ex-composer-queue';
  for (const theme of ['light', 'dark']) {
    await capture.theme(theme);
    for (const reduced of [false, true]) {
      await capture.reducedMotion(reduced);
      await capture.viewport(reduced ? 1000 : 1440, reduced ? 680 : 960);
      await capture.component('ex-connected-workspace-demo', component => component.fixture.chat.scenario('running'));
      await capture.waitFor(() => document.querySelector('ex-composer .send')?.textContent.includes('Queue') && !document.querySelector('ex-composer-queue .item'));
      await capture.motion.finish(); await capture.settle();
      for (let count = 1; count <= 3; count++) {
        await capture.fill('ex-composer textarea', count === 1 ? 'Document the fallback behavior' : 'Add a regression test');
        await capture.evaluate(expected => {
          const input = document.querySelector('ex-composer .input-height');
          const sample = window.queueMotionSample = { heights: [], rows: [], done: false, row: null, identityChanged: false };
          const started = performance.now();
          const frame = now => {
            const rows = document.querySelectorAll('ex-composer-queue .item');
            sample.heights.push(input.getBoundingClientRect().height);
            sample.rows.push(rows.length);
            if (rows.length === expected) {
              sample.row ??= rows[expected - 1];
              if (sample.row !== rows[expected - 1]) sample.identityChanged = true;
            }
            if (now - started < 800) requestAnimationFrame(frame);
            else sample.done = true;
          };
          requestAnimationFrame(frame);
        }, count);
        await capture.press('Enter');
        await capture.waitFor(() => window.queueMotionSample.done);
        const sample = await capture.evaluate(() => {
          const { row, ...sample } = window.queueMotionSample;
          return { ...sample, retained: row?.isConnected, focused: document.activeElement === document.querySelector('ex-composer textarea') };
        });
        const settled = sample.heights.at(-1);
        assert.ok(sample.heights.length > 5, 'Sample real animation frames');
        assert.ok(sample.rows.every(rows => rows <= count), 'Receipt must never create an extra exiting queue row');
        assert.equal(sample.identityChanged, false, 'Receipt must preserve the mounted optimistic row');
        assert.equal(sample.retained, true);
        assert.equal(sample.focused, true);
        assert.ok(Math.max(...sample.heights) <= settled + 1, `Queue height overshot ${settled}: ${Math.max(...sample.heights)}`);
        yield { name: `${theme}-${reduced ? 'narrow-reduced' : 'motion'}-${count}`, inspect: ['ex-composer', queue], metadata: { sample } };
      }
      // Native keyboard removal must address the saved ID, not the render key.
      await capture.evaluate(() => document.querySelector('ex-composer-queue .item:last-child [aria-label="Remove queued message"]').focus());
      await capture.press('Enter');
      await capture.waitFor(() => document.querySelectorAll('ex-composer-queue .item').length === 2);
      yield { name: `${theme}-${reduced ? 'narrow-reduced' : 'motion'}-removed`, inspect: [queue] };
    }
  }
}
