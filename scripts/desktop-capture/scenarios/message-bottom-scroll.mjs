import assert from 'node:assert/strict';

/** Record real frames from before send in a full, bounded history window. */
export default async function* (capture) {
  await capture.evaluate(() => { location.href = '/connected-workspace'; });
  await capture.waitFor(() => document.querySelector('ex-workspace-navigation ex-task-list'));
  await capture.component('ex-machine-workspace', c => c.store.selectSession({ taskId: '11', sessionId: '101' }));
  const idle = async () => {
    await capture.motion.play();
    await capture.waitFor(() => document.getAnimations().every(a => !Number.isFinite(a.effect?.getComputedTiming().endTime) || a.playState !== 'running'));
  };
  const reset = async () => {
    await capture.component('ex-connected-workspace-demo', c => {
      c.fixture.chat.scenario('history', 101); c.fixture.chat.deferUserReceipts(false);
    });
    await capture.waitFor(() => document.querySelectorAll('ex-message').length >= 30 && !document.querySelector('ex-turn.live'));
    await idle();
    await capture.component('ex-chat-scroll', c => c.scrollToEnd('instant'));
    await capture.settle();
  };
  for (const theme of ['light', 'dark']) {
    await capture.theme(theme); await capture.reducedMotion(false); await capture.viewport(1440, 960);
    for (const long of [false, true]) {
      await reset();
      await capture.fill('ex-composer textarea', long
        ? Array.from({ length: 10 }, (_, i) => `Line ${i + 1}: open space for this message smoothly.`).join('\n')
        : 'Open space for my message, then bring Working into view.');
      await idle();
      const probe = await capture.component('ex-session-chat', async c => {
        const viewport = document.querySelector('ex-chat-scroll .viewport');
        const oldTurn = document.querySelector('ex-turn:last-of-type');
        const oldMessage = document.querySelector('ex-message:last-of-type');
        const samples = [];
        const sample = (time = performance.now()) => {
          const lastMessage = document.querySelector('ex-message:last-of-type');
          const message = lastMessage !== oldMessage ? lastMessage : null;
          const copy = document.querySelector('.send-flight .content');
          const visual = copy || message?.querySelector('.content');
          return { time, tail: oldTurn.getBoundingClientRect().top,
            scroll: viewport.scrollTop, end: viewport.scrollHeight - viewport.clientHeight,
            fly: !!copy, bubble: visual?.getBoundingClientRect().top ?? null,
            owned: viewport.getAnimations().some(a => a.id === 'chat-send-scroll'),
            returnVisible: !!document.querySelector('ex-chat-scroll .return.visible') };
        };
        samples.push(sample()); c.composer().send();
        // Cover entry, composer shrink and early streaming. Completion has its
        // own regression; this fixture finishes its reply after about 1.5s.
        for (let i = 0; i < 50; i++) {
          const time = await new Promise(requestAnimationFrame);
          samples.push(sample(time));
        }
        return { samples, retained: oldTurn.isConnected, focus: document.activeElement.matches('ex-composer textarea') };
      });
      const samples = probe.samples;
      yield { name: `${theme}-${long ? 'long' : 'short'}-natural`, inspect: ['ex-chat-scroll', 'ex-composer'], metadata: { probe } };
      assert.equal(probe.retained, true); assert.equal(probe.focus, true);
      assert.ok(Math.abs(samples[1].tail - samples[0].tail) < 8, 'No first-painted-frame jump at the bottom');
      assert.ok(samples.some(s => s.owned), 'The real scroll has one arrival owner');
      assert.ok(samples.some(s => Math.abs(s.end - s.scroll) > 15 && s.owned), 'Reveal the new exchange progressively');
      assert.ok(!samples.some(s => s.owned && s.returnVisible), 'Do not flash the return button during an owned reveal');
      for (let i = 1; i < samples.length; i++) {
        const a = samples[i - 1], b = samples[i], dt = b.time - a.time;
        assert.ok(Math.abs(b.tail - a.tail) < Math.max(9, dt * 3), `Abrupt history movement: ${JSON.stringify({ a, b })}`);
        if (a.fly && !b.fly && a.bubble !== null && b.bubble !== null)
          assert.ok(Math.abs(b.bubble - a.bubble) < Math.max(5, dt), 'The flight must meet its moving bubble without a landing jump');
      }
      assert.ok(samples.at(-1).end - samples.at(-1).scroll < 1, 'Settle at the latest reply');
    }

    // Frozen frames make the scroll reveal directly reviewable alongside the fly.
    await reset(); await capture.fill('ex-composer textarea', 'Make room, land the bubble, then settle Working.');
    await capture.motion.freeze(); await capture.press('Enter');
    for (const age of [0, 100, 220, 420, 700]) {
      await capture.evaluate(age => {
        for (const a of document.getAnimations()) if (Number.isFinite(a.effect?.getComputedTiming().endTime)) a.currentTime = age;
      }, age);
      await capture.settle();
      yield { name: `${theme}-reveal-${age}ms`, inspect: ['.send-flight', 'ex-turn:last-of-type', 'ex-chat-scroll .viewport'] };
    }
    await capture.motion.play(); await idle();

    await reset(); await capture.fill('ex-composer textarea', 'The wheel can take over this reveal.');
    await capture.motion.freeze(); await capture.press('Enter');
    await capture.evaluate(() => {
      for (const a of document.getAnimations()) if (Number.isFinite(a.effect?.getComputedTiming().endTime)) a.currentTime = 100;
    });
    await capture.settle();
    const point = await capture.evaluate(() => {
      const r = document.querySelector('ex-chat-scroll .viewport').getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await capture.cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaY: -180, deltaX: 0 });
    await capture.waitFor(() => !document.querySelector('.send-flight') && !document.querySelector('ex-chat-scroll .viewport').getAnimations().some(a => a.id === 'chat-send-scroll'));
    await capture.motion.play(); await capture.settle();
    assert.ok(await capture.evaluate(() => {
      const v = document.querySelector('ex-chat-scroll .viewport'); return v.scrollHeight - v.scrollTop - v.clientHeight > 50;
    }), 'Keep the reader’s scroll position after takeover');
    yield { name: `${theme}-wheel-takeover`, inspect: ['ex-chat-scroll', 'ex-composer'] };

    await reset(); await capture.viewport(1000, 760); await capture.reducedMotion(true);
    await capture.fill('ex-composer textarea', 'A reduced-motion send at the end'); await capture.press('Enter');
    await capture.settle();
    assert.ok(await capture.evaluate(() => {
      const v = document.querySelector('ex-chat-scroll .viewport');
      return v.scrollHeight - v.scrollTop - v.clientHeight < 1 && !v.getAnimations().some(a => a.id === 'chat-send-scroll') && !document.querySelector('.send-flight');
    }));
    yield { name: `${theme}-narrow-reduced`, inspect: ['ex-chat-scroll', 'ex-composer'] };
  }
}
