import assert from 'node:assert/strict';

/** Real chat geometry: useful context, small reversals, neighbouring prompts and keyboard return. */
export default async function* (capture) {
  await capture.evaluate(() => { location.href = '/conversation'; });
  await capture.waitFor(() => document.querySelector('ex-conversation-demo ex-chat'));
  const configure = () => capture.component('ex-conversation-demo', component => component.exchanges.set([
    {
      id: 'context', prompt: 'Explain the retry policy, including cancellation, bounded delays and how failed requests recover without replaying mutations.',
      status: 'done', steps: [], harness: 'codex',
      answer: Array.from({ length: 40 }, (_, index) => `### Retry boundary ${index + 1}\n\nKeep each request scoped to its owner. Cancellation stops pending reads, bounded delays prevent rapid retries, and uncertain mutations are reconciled before another attempt.\n\nThe response remains readable while you inspect earlier work.`).join('\n\n'),
    },
    { id: 'short', prompt: 'Does cancellation preserve the reading position?', status: 'done', steps: [], answer: 'Yes. Pending reads are cancelled while the transcript keeps its reading position.' },
    { id: 'following', prompt: 'Show the recovery cases as well.', status: 'done', steps: [], answer: Array.from({ length: 30 }, (_, index) => `### Recovery case ${index + 1}\n\nReconcile durable state before retrying. Preserve the selected session and discard replies from the previous scope.`).join('\n\n') },
  ]));
  const move = async (id, gap) => {
    await capture.evaluate(({ id, gap }) => {
      const viewport = document.querySelector('.demo-chat .viewport');
      const message = document.querySelector(`[data-user-message="${id}"]`);
      viewport.scrollTop += message.getBoundingClientRect().bottom - viewport.getBoundingClientRect().top + gap;
      viewport.dispatchEvent(new window.Event('scroll'));
    }, { id, gap });
    await capture.settle();
  };
  const shown = () => capture.evaluate(() => !!document.querySelector('.demo-chat .reminder'));
  for (const theme of ['light', 'dark']) {
    await capture.theme(theme);
    for (const narrow of [false, true]) {
      await capture.viewport(narrow ? 520 : 1280, 1100);
      await capture.reducedMotion(narrow);
      await capture.component('ex-conversation-demo', component => component.exchanges.set([]));
      await configure();
      const name = `${theme}-${narrow ? 'narrow-reduced' : 'wide'}`;
      await move('context', 8);
      assert.equal(await shown(), false, 'A barely clipped prompt needs no reminder');
      yield { name: `${name}-slightly-scrolled`, selector: '.demo-chat', inspect: ['.demo-chat .viewport'] };

      await move('context', 400);
      assert.equal(await shown(), true, 'Deep into a long reply, context is useful');
      const geometry = await capture.evaluate(() => {
        const reminder = document.querySelector('.demo-chat .reminder');
        const viewport = document.querySelector('.demo-chat .viewport');
        const prompt = reminder.querySelector('.prompt span');
        return { height: reminder.getBoundingClientRect().height, viewport: viewport.clientHeight,
          overflow: reminder.scrollWidth > reminder.clientWidth, ellipsis: getComputedStyle(prompt).textOverflow };
      });
      assert.ok(geometry.height <= 42 && geometry.height < geometry.viewport / 8, JSON.stringify(geometry));
      assert.equal(geometry.overflow, false);
      assert.equal(geometry.ellipsis, 'ellipsis');
      yield { name: `${name}-useful-context`, selector: '.demo-chat', metadata: geometry, inspect: ['.demo-chat .reminder', '.demo-chat .prompt'] };

      const distance = await capture.evaluate(() => Math.min(320, Math.max(160, document.querySelector('.demo-chat .viewport').clientHeight * 0.35)));
      await move('context', distance - 24);
      assert.equal(await shown(), true, 'Small scroll reversals retain context');
      await move('context', distance - 60);
      assert.equal(await shown(), false);
      await move('context', distance - 24);
      assert.equal(await shown(), false, 'The entry margin prevents boundary flicker');
      await move('context', 400);

      // Keep the next prompt at the lower edge; the old reminder must disappear
      // even though the previous prompt is still far above the viewport.
      await capture.evaluate(() => {
        const viewport = document.querySelector('.demo-chat .viewport');
        const next = document.querySelector('[data-user-message="short"]');
        viewport.scrollTop += next.getBoundingClientRect().top - viewport.getBoundingClientRect().bottom + 30;
        viewport.dispatchEvent(new window.Event('scroll'));
      });
      await capture.settle();
      assert.equal(await shown(), false, 'A neighbouring visible prompt supplies enough context');
      yield { name: `${name}-next-prompt`, selector: '.demo-chat', inspect: ['[data-user-message="short"]'] };

      await move('short', 8);
      assert.equal(await shown(), false, 'A short reply should not acquire a reminder');
      await move('following', 400);
      assert.equal(await shown(), true);
      await capture.evaluate(() => document.querySelector('.demo-chat .reminder .hide').focus());
      await capture.press('Enter');
      assert.equal(await shown(), false);
      assert.equal(await capture.evaluate(() => document.activeElement === document.querySelector('.demo-chat .viewport')), true);
      await move('following', 500);
      assert.equal(await shown(), false, 'Hide lasts for this prompt');

      // Dismissal of the following prompt does not affect an earlier exchange.
      await move('context', 400);
      assert.equal(await shown(), true);
      await capture.evaluate(() => document.querySelector('.demo-chat .reminder .prompt').focus());
      await capture.press('Enter');
      await capture.waitFor(() => {
        const viewport = document.querySelector('.demo-chat .viewport');
        const message = document.querySelector('[data-user-message="context"]');
        return message.getBoundingClientRect().top >= viewport.getBoundingClientRect().top;
      });
      assert.equal(await shown(), false);
      assert.equal(await capture.evaluate(() => document.activeElement === document.querySelector('.demo-chat .viewport')), true);
      yield { name: `${name}-keyboard-return`, selector: '.demo-chat', inspect: ['.demo-chat .viewport', '[data-user-message="context"]'] };
    }
  }
}
