import assert from 'node:assert/strict';

/** Real chat geometry: useful context, small reversals, neighbouring prompts,
 * exchange swaps, the island's charge and spring-open peek, motion frames and
 * keyboard return. */
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
  // A leaving reminder stays mounted for its exit; it no longer counts as shown.
  const shown = () => capture.evaluate(() => !!document.querySelector('.demo-chat .reminder:not(.reminder-leave)'));
  const rest = () => capture.waitFor(() => !document.querySelector(
    '.demo-chat :is(.reminder-enter, .reminder-leave, .quote-enter, .quote-leave)'));
  // Scrubbing tracks every running animation; let theme and hover transitions end first.
  const quiet = async () => {
    await rest();
    await capture.evaluate(() => new Promise(resolve => setTimeout(resolve, 400)));
  };
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
      await rest();
      yield { name: `${name}-slightly-scrolled`, selector: '.demo-chat', inspect: ['.demo-chat .viewport'] };

      if (!narrow) {
        // Entry: slides down 8px and fades in on ease-out; frames are scrubbed.
        await quiet();
        await capture.motion.freeze();
        await move('context', 400);
        yield* capture.frames(`${name}-enter`, [0, 90, 180, 280], ['.demo-chat .reminder']);
        await capture.motion.finish();
        await capture.motion.play();
      } else await move('context', 400);
      await rest();
      assert.equal(await shown(), true, 'Deep into a long reply, context is useful');
      const geometry = await capture.evaluate(() => {
        const card = document.querySelector('.demo-chat .reminder .surface');
        const viewport = document.querySelector('.demo-chat .viewport');
        const quote = card.querySelector('.quote');
        const column = document.querySelector('.demo-chat .content').getBoundingClientRect();
        const bounds = card.getBoundingClientRect();
        const style = getComputedStyle(quote);
        return { height: bounds.height, viewport: viewport.clientHeight,
          overflow: card.scrollWidth > card.clientWidth, clamp: style.webkitLineClamp,
          lines: Math.round(quote.getBoundingClientRect().height / parseFloat(style.lineHeight)),
          left: Math.round(bounds.left - column.left), right: Math.round(column.right - bounds.right) };
      });
      assert.ok(geometry.height <= 40, JSON.stringify(geometry));
      assert.equal(geometry.overflow, false);
      assert.equal(geometry.clamp, '1');
      assert.equal(geometry.lines, 1, JSON.stringify(geometry));
      yield { name: `${name}-useful-context`, selector: '.demo-chat', metadata: geometry, inspect: ['.demo-chat .reminder', '.demo-chat .reminder .surface'] };

      if (!narrow) {
        // A jump straight into another exchange keeps the card and blurs its text over.
        await quiet();
        await capture.motion.freeze();
        await move('following', 400);
        yield* capture.frames(`${name}-swap`, [0, 80, 160, 240], ['.demo-chat .reminder .quote-stack']);
        await capture.motion.finish();
        await capture.motion.play();
        await rest();
        assert.equal(await capture.evaluate(() => document.querySelector('.demo-chat .reminder .quote').textContent), 'Show the recovery cases as well.');
        await move('context', 400);
        await rest();
      }

      const distance = await capture.evaluate(() => Math.min(96, Math.max(48, document.querySelector('.demo-chat .viewport').clientHeight * 0.12)));
      await move('context', distance - 12);
      assert.equal(await shown(), true, 'Small scroll reversals retain context');
      await move('context', distance - 36);
      assert.equal(await shown(), false);
      await move('context', distance - 12);
      assert.equal(await shown(), false, 'The entry margin prevents boundary flicker');
      await move('context', 400);

      // Context stays useful while the next prompt is only at the bottom edge.
      // Hand off when it reaches the legacy chat's upper reading probe.
      await capture.evaluate(() => {
        const viewport = document.querySelector('.demo-chat .viewport');
        const next = document.querySelector('[data-user-message="short"]');
        viewport.scrollTop += next.getBoundingClientRect().top - viewport.getBoundingClientRect().bottom + 30;
        viewport.dispatchEvent(new window.Event('scroll'));
      });
      await capture.settle();
      assert.equal(await shown(), true, 'Keep context while the reader is still following the old response');
      await rest();
      yield { name: `${name}-next-prompt-at-bottom`, selector: '.demo-chat', inspect: ['.demo-chat .reminder', '[data-user-message="short"]'] };
      await capture.evaluate(() => {
        const viewport = document.querySelector('.demo-chat .viewport');
        const next = document.querySelector('[data-user-message="short"]');
        const probe = Math.min(160, Math.max(48, viewport.clientHeight * 0.28));
        viewport.scrollTop += next.getBoundingClientRect().top - viewport.getBoundingClientRect().top - probe + 1;
        viewport.dispatchEvent(new window.Event('scroll'));
      });
      await capture.settle();
      assert.equal(await shown(), false, 'Visible prompts take over in the upper reading area');
      await rest();
      yield { name: `${name}-next-prompt-at-top`, selector: '.demo-chat', inspect: ['[data-user-message="short"]'] };

      await move('short', 8);
      assert.equal(await shown(), false, 'A short reply should not acquire a reminder');
      await move('context', 400);
      await rest();
      // Passing over it doesn't open it; resting on it charges, then opens.
      const lines = () => capture.evaluate(() => {
        const quote = document.querySelector('.demo-chat .reminder .quote');
        return Math.round(quote.getBoundingClientRect().height / parseFloat(getComputedStyle(quote).lineHeight));
      });
      const classes = () => capture.evaluate(() => document.querySelector('.demo-chat .reminder').className);
      if (!narrow) {
        // The charge, scrubbed: swell, warm border, filling ↑ well. Set through
        // the public signal so its 320ms transition can be sampled in isolation.
        await quiet();
        await capture.motion.freeze();
        await capture.component('.demo-chat ex-chat-scroll', component => component.arming.set(true));
        yield* capture.frames(`${name}-charge`, [0, 110, 220, 320], ['.demo-chat .reminder .surface']);
        await capture.motion.finish();
        await capture.motion.play();
        await capture.component('.demo-chat ex-chat-scroll', component => component.arming.set(false));
        await quiet();
        // The release, scrubbed: the real pointer rests, the timer opens it,
        // and the box springs to three lines.
        await capture.motion.freeze();
        await capture.hover('.demo-chat .reminder .surface');
        await capture.waitFor(() => document.querySelector('.demo-chat .reminder.peek'));
        yield* capture.frames(`${name}-release`, [0, 90, 180, 280, 420], ['.demo-chat .reminder .surface']);
        await capture.motion.finish();
        await capture.motion.play();
      } else {
        // Narrow runs use reduced motion: no charge, it simply opens after the wait.
        await capture.hover('.demo-chat .reminder .surface');
        assert.doesNotMatch(await classes(), /arming|peek/);
        await capture.waitFor(() => document.querySelector('.demo-chat .reminder.peek'));
      }
      await rest();
      await capture.evaluate(() => new Promise(resolve => setTimeout(resolve, 500)));
      assert.ok(await lines() > 1, 'Resting on the reminder peeks at more of a long prompt');
      yield { name: `${name}-peek`, selector: '.demo-chat', inspect: ['.demo-chat .reminder .surface'] };
      await capture.hover('.demo-chat .viewport');
      await capture.waitFor(() => !document.querySelector('.demo-chat .reminder.peek'));
      assert.equal(await lines(), 1);

      await move('context', 400);
      await rest();
      await capture.evaluate(() => document.querySelector('.demo-chat .reminder .surface').focus());
      await capture.press('Enter');
      await capture.waitFor(() => {
        const viewport = document.querySelector('.demo-chat .viewport');
        const message = document.querySelector('[data-user-message="context"]');
        return message.getBoundingClientRect().top >= viewport.getBoundingClientRect().top;
      });
      assert.equal(await shown(), false);
      assert.equal(await capture.evaluate(() => document.activeElement === document.querySelector('.demo-chat .viewport')), true);
      await rest();
      yield { name: `${name}-keyboard-return`, selector: '.demo-chat', inspect: ['.demo-chat .viewport', '[data-user-message="context"]'] };
    }
  }
}
