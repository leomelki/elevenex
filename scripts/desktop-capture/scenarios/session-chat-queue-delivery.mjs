import assert from 'node:assert/strict';

/** The queue hands off to one mounted bubble before any harness output. */
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
      await capture.component('ex-connected-workspace-demo', component => {
        component.fixture.chat.scenario('running');
        component.fixture.chat.deferUserReceipts(true);
      });
      await capture.component('ex-session-chat', component => component.store.refresh());
      await capture.waitFor(() => document.querySelector('ex-composer button.send[aria-label^="Queue message"]'));
      await capture.motion.finish();
      await capture.settle();
      for (let i = 0; i < 2; i++) {
        await capture.fill('ex-composer textarea', 'Add a queue delivery regression test');
        await capture.press('Enter');
        await capture.waitFor(count => document.querySelectorAll('ex-composer-queue .item').length === count && !document.querySelector('ex-composer-queue button:disabled'), i + 1);
        await capture.motion.finish();
        await capture.settle();
      }
      const inspect = ['ex-chat-scroll', 'ex-composer-queue', 'ex-message:last-of-type', 'ex-turn:last-of-type'];
      for (const [index, delivery] of ['steer', 'automatic'].entries()) {
        const key = `${theme}-${narrow ? 'narrow-reduced' : 'wide'}-${delivery}`;
        if (!narrow) await capture.motion.freeze();
        if (delivery === 'steer') {
          await capture.evaluate(() => document.querySelector('ex-composer-queue [aria-label="Steer now"]').focus());
          await capture.press('Enter');
        } else {
          await capture.component('ex-connected-workspace-demo', component => component.fixture.chat.dispatchQueuedPrompt());
        }
        await capture.waitFor(count => [...document.querySelectorAll('ex-chat [data-user-message]')]
          .filter(node => node.textContent.includes('Add a queue delivery regression test')).length === count, index + 1);
        const pending = await capture.evaluate(() => {
          const bubble = document.querySelector('ex-message:last-of-type');
          bubble.dataset.queueDelivery = 'entering';
          return {
            focus: document.activeElement.matches('ex-composer textarea'),
            answer: document.querySelector('ex-turn:last-of-type')?.textContent.includes('Applying the queued guidance.'),
          };
        });
        assert.equal(pending.answer, false, 'The user message appears before the answer');
        assert.equal(pending.focus, true);
        if (!narrow) {
          yield* capture.frames(`${key}-handoff`, [80, 160, 420], inspect);
          await capture.motion.play();
        }
        await capture.motion.finish();
        await capture.settle();
        assert.equal(await capture.evaluate(() => document.querySelectorAll('ex-composer-queue .item').length), 1 - index);
        yield { name: `${key}-before-output`, inspect };
        await capture.component('ex-connected-workspace-demo', component => component.fixture.chat.finishQueuedPrompt());
        await capture.waitFor(() => document.querySelector('ex-turn:last-of-type')?.textContent.includes('Applying the queued guidance.'));
        assert.equal(await capture.evaluate(() => document.querySelector('ex-message:last-of-type')?.dataset.queueDelivery), 'entering', 'The receipt keeps the mounted bubble');
      }
      await capture.component('ex-session-chat', component => component.store.refresh());
      await capture.waitFor(() => document.querySelector('ex-turn:last-of-type')?.textContent.includes('Applying the queued guidance.'));
      assert.equal(await capture.evaluate(() => [...document.querySelectorAll('ex-chat [data-user-message]')].filter(node => node.textContent.includes('Add a queue delivery regression test')).length), 2);
    }
  }
}
