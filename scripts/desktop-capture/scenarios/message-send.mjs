import assert from 'node:assert/strict';

/** Public send path: source/landing geometry, fallbacks, focus and disposal. */
export default async function* (capture) {
  await capture.evaluate(() => { location.href = '/conversation'; });
  await capture.waitFor(() => document.querySelector('.demo-chat ex-composer textarea'));
  const finish = async () => {
    await capture.evaluate(() => {
      for (const animation of document.getAnimations())
        if (Number.isFinite(animation.effect?.getComputedTiming().endTime)) animation.finish();
    });
    await capture.motion.play();
    await capture.settle();
  };
  const seek = async age => {
    await capture.evaluate(age => {
      for (const animation of document.getAnimations())
        if (Number.isFinite(animation.effect?.getComputedTiming().endTime)) animation.currentTime = age;
    }, age);
    await capture.settle();
  };
  const reset = async () => {
    await finish();
    await capture.component('ex-conversation-demo', c => {
      c.running.set(false); c.queue.set([]);
      c.exchanges.set(Array.from({ length: 6 }, (_, i) => ({
        id: `history-${i}`, prompt: `Earlier question ${i + 1}`,
        status: 'done', steps: [], answer: 'An existing reply.\n\nHistory stays still when the chat opens.',
      })));
    });
    await capture.component('.demo-chat ex-chat-scroll', c => c.scrollToEnd('instant'));
    await finish();
  };
  const inspect = ['.send-flight', '.demo-chat ex-message:last-of-type', '.demo-chat ex-composer'];
  for (const theme of ['light', 'dark']) {
    await capture.theme(theme); await capture.viewport(1440, 960); await capture.reducedMotion(false);
    await reset();
    assert.equal(await capture.evaluate(() => document.querySelectorAll('.send-flight').length), 0);
    const words = 'These words lift from the input and land in their bubble.';
    await capture.fill('.demo-chat ex-composer textarea', words);
    const source = await capture.evaluate(() => {
      const input = document.querySelector('.demo-chat textarea');
      const rect = input.getBoundingClientRect(), style = getComputedStyle(input);
      return { left: rect.left + parseFloat(style.paddingLeft), top: rect.top + parseFloat(style.paddingTop),
        tail: document.querySelector('.demo-chat ex-turn:last-of-type').getBoundingClientRect().top };
    });
    await capture.motion.freeze(); await capture.press('Enter');
    const start = await capture.evaluate(() => {
      const copy = document.querySelector('.send-flight'), input = document.querySelector('.demo-chat textarea');
      const rect = copy.querySelector('.content').getBoundingClientRect();
      const animations = document.getAnimations().filter(a => Number.isFinite(a.effect?.getComputedTiming().endTime));
      return { left: rect.left, top: rect.top, words: copy.textContent, inert: copy.inert,
        hidden: copy.getAttribute('aria-hidden'), focus: document.activeElement === input, draft: input.value, placeholderOpacity: getComputedStyle(input, '::placeholder').opacity,
        tail: document.querySelectorAll('.demo-chat ex-turn')[5].getBoundingClientRect().top,
        animations: animations.map(a => ({ duration: a.effect.getTiming().duration, easing: a.effect.getTiming().easing,
          target: a.effect.target.className, frames: a.effect.getKeyframes() })) };
    });
    assert.equal(start.words, words); assert.equal(start.inert, true); assert.equal(start.hidden, 'true');
    assert.equal(start.focus, true); assert.equal(start.draft, '');
    assert.equal(start.placeholderOpacity, '0');
    assert.ok(Math.abs(start.left - source.left) < 1); assert.ok(Math.abs(start.top - source.top) < 1);
    assert.ok(Math.abs(start.tail - source.tail) < 1, 'Existing conversation must not jump on send');
    assert.ok(start.animations.some(a => a.duration === 380 && a.easing.startsWith('linear(')));
    assert.ok(start.animations.some(a => a.duration === 340));
    assert.ok(start.animations.some(a => a.duration === 320 && a.frames[0].transform === 'scale(0.86)'));
    yield { name: `${theme}-flight-0`, inspect, metadata: { source, start } };
    await seek(100);
    yield { name: `${theme}-flight-100`, inspect };
    await seek(190);
    yield { name: `${theme}-flight-190`, inspect };
    await seek(380);
    assert.equal(await capture.evaluate(() => document.querySelectorAll('.send-flight').length), 0);
    assert.equal(await capture.evaluate(() => getComputedStyle(document.querySelector('.demo-chat ex-message:last-of-type')).visibility), 'visible');
    assert.equal(await capture.evaluate(() => getComputedStyle(document.querySelector('.demo-chat textarea'), '::placeholder').opacity), '1');
    yield { name: `${theme}-landed`, inspect };
    await finish();

    // A later receipt without a local origin rises; it must still come into view.
    await capture.motion.freeze();
    await capture.component('ex-conversation-demo', c => c.exchanges.update(items => [...items, {
      id: 'remote', prompt: 'A message arriving from another window', isNew: true,
      status: 'done', steps: [], answer: '',
    }]));
    assert.equal(await capture.evaluate(() => document.querySelectorAll('.send-flight').length), 0);
    await seek(100); yield { name: `${theme}-no-origin-rise`, inspect };
    await finish();

    // Queueing never creates a flight or a transcript row.
    await capture.component('ex-conversation-demo', c => c.running.set(true));
    const count = await capture.evaluate(() => document.querySelectorAll('.demo-chat ex-message').length);
    await capture.fill('.demo-chat textarea', 'Keep this in the queue'); await capture.press('Enter');
    assert.equal(await capture.evaluate(() => document.querySelectorAll('.demo-chat ex-message').length), count);
    assert.equal(await capture.evaluate(() => document.querySelectorAll('.send-flight').length), 0);
    yield { name: `${theme}-queued`, inspect };
    await capture.component('ex-conversation-demo', c => c.running.set(false));
    await finish();

    const longText = Array.from({ length: 14 }, (_, i) => `Line ${i + 1}: preserve the complete message.`).join('\n');
    await capture.fill('.demo-chat textarea', longText); await capture.settle();
    await capture.motion.freeze(); await capture.press('Enter');
    assert.equal(await capture.evaluate(() => document.querySelectorAll('.send-flight').length), 0);
    await seek(100); yield { name: `${theme}-long-rise`, inspect };
    await finish();
    assert.equal(await capture.evaluate(() => document.querySelector('.demo-chat ex-message:last-of-type .content').textContent), longText);

    // A send from a scrolled-up conversation always returns to the new prompt.
    await capture.evaluate(() => {
      const viewport = document.querySelector('.demo-chat .viewport');
      viewport.scrollTop = 0; viewport.dispatchEvent(new window.Event('scroll'));
    });
    await capture.fill('.demo-chat textarea', 'Bring my new message into view');
    await capture.motion.freeze(); await capture.press('Enter');
    assert.ok(await capture.evaluate(() => {
      const el = document.querySelector('.demo-chat .viewport');
      return el.getAnimations().some(animation => animation.id === 'chat-send-scroll') ||
        el.scrollHeight - el.scrollTop - el.clientHeight < 1;
    }), 'Own the smooth reveal back to the new message');
    // Removing the mounted message while flying releases the copy immediately.
    await capture.component('ex-conversation-demo', c => c.exchanges.set([]));
    assert.equal(await capture.evaluate(() => document.querySelectorAll('.send-flight').length), 0);
    yield { name: `${theme}-interrupted`, inspect: ['.demo-chat ex-composer'] };
    await finish();

    await capture.viewport(600, 760); await capture.reducedMotion(true); await reset();
    await capture.fill('.demo-chat textarea', 'A quiet send with reduced motion');
    await capture.motion.freeze(); await capture.press('Enter');
    const fade = await capture.evaluate(() => {
      const message = document.querySelector('.demo-chat ex-message:last-of-type');
      return { animations: message.getAnimations().map(a => ({ duration: a.effect.getTiming().duration, frames: a.effect.getKeyframes() })),
        copy: !!document.querySelector('.send-flight'), focus: document.activeElement.matches('textarea') };
    });
    assert.equal(fade.copy, false); assert.equal(fade.focus, true);
    assert.ok(fade.animations.some(a => a.duration === 160 && a.frames.every(f => !f.transform)));
    await seek(80); yield { name: `${theme}-narrow-reduced`, inspect, metadata: { fade } };
    await finish();
  }

  // The actual connected owner carries source geometry only to its optimistic prompt.
  await capture.viewport(1440, 960); await capture.reducedMotion(false);
  await capture.evaluate(() => { location.href = '/connected-workspace'; });
  await capture.waitFor(() => document.querySelector('ex-workspace-navigation ex-task-list'));
  await capture.component('ex-machine-workspace', c => c.store.selectSession({ taskId: '11', sessionId: '101' }));
  await capture.component('ex-connected-workspace-demo', c => { c.fixture.chat.scenario('reply-only'); c.fixture.chat.deferUserReceipts('completion'); });
  await capture.waitFor(() => document.querySelector('ex-composer textarea'));
  await capture.fill('ex-composer textarea', 'Send through the connected owner');
  await finish(); await capture.motion.freeze(); await capture.press('Enter');
  await capture.waitFor(() => document.querySelector('.send-flight'));
  yield { name: 'connected-flight', inspect: ['.send-flight', 'ex-session-chat ex-message:last-of-type', 'ex-composer'] };
  await finish();
  assert.equal(await capture.evaluate(() => document.querySelectorAll('.send-flight').length), 0);
  yield { name: 'connected-landed', inspect: ['ex-session-chat ex-message:last-of-type', 'ex-composer'] };
}
