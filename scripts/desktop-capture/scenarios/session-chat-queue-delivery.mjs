import assert from 'node:assert/strict';

/** Queued receipts enter real chat turns without an optimistic local send. */
export default async function* (capture) {
  await capture.evaluate(() => { location.href = '/connected-workspace'; });
  await capture.waitFor(() => document.querySelector('ex-workspace-navigation ex-task-list'));
  await capture.component('ex-machine-workspace', component => component.store.selectSession({ taskId: '11', sessionId: '101' }));
  await capture.waitFor(() => document.querySelector('ex-composer textarea'));
  for (const theme of ['light', 'dark']) {
    await capture.theme(theme);
    for (const narrow of [false, true]) {
      await capture.viewport(narrow ? 1000 : 1440, narrow ? 760 : 960);
      await capture.reducedMotion(narrow);
      await capture.component('ex-connected-workspace-demo', component => component.fixture.chat.scenario('running'));
      await capture.component('ex-session-chat', component => component.store.refresh());
      await capture.waitFor(() => document.querySelector('ex-composer .send')?.textContent.includes('Queue'));
      await capture.motion.finish();
      await capture.settle();
      for (let i = 0; i < 2; i++) {
        await capture.fill('ex-composer textarea', 'Add a queue delivery regression test');
        await capture.press('Enter');
        await capture.waitFor(count => document.querySelectorAll('ex-composer-queue .item').length === count && !document.querySelector('ex-composer-queue button:disabled'), i + 1);
        await capture.motion.finish();
        await capture.settle();
      }
      // Use native keyboard activation; the saved queue ID must reach the owner.
      await capture.evaluate(() => document.querySelector('ex-composer-queue [aria-label="Steer now"]').focus());
      await capture.press('Enter');
      await capture.waitFor(() => [...document.querySelectorAll('ex-chat [data-user-message]')].some(node => node.textContent.includes('Add a queue delivery regression test')));
      await capture.motion.finish();
      await capture.settle();
      assert.equal(await capture.evaluate(() => document.querySelectorAll('ex-composer-queue .item').length), 1);
      assert.equal(await capture.evaluate(() => [...document.querySelectorAll('ex-chat [data-user-message]')].filter(node => node.textContent.includes('Add a queue delivery regression test')).length), 1);
      assert.equal(await capture.evaluate(() => document.querySelector('ex-turn:last-of-type')?.textContent.includes('Applying the queued guidance.')), true);
      await capture.evaluate(() => [...document.querySelectorAll('ex-chat [data-user-message]')].at(-1)?.scrollIntoView({ block: 'center' }));
      yield { name: `${theme}-${narrow ? 'narrow-reduced' : 'wide'}-queue-delivered`, inspect: ['ex-chat-scroll', 'ex-composer-queue', 'ex-turn:last-of-type'] };
      // A history reload must retain exactly one saved prompt.
      await capture.component('ex-session-chat', component => component.store.refresh());
      await capture.waitFor(() => document.querySelector('ex-turn:last-of-type')?.textContent.includes('Applying the queued guidance.'));
      assert.equal(await capture.evaluate(() => [...document.querySelectorAll('ex-chat [data-user-message]')].filter(node => node.textContent.includes('Add a queue delivery regression test')).length), 1);
    }
  }
}
