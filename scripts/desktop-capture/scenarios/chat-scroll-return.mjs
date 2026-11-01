import assert from 'node:assert/strict';

/** Connected chat return control, native smooth travel and keyboard handoff. */
export default async function* (capture) {
  await capture.evaluate(() => { location.href = '/connected-workspace'; });
  await capture.waitFor(() => document.querySelector('ex-workspace-navigation ex-task-list'));
  await capture.component('ex-connected-workspace-demo', component => {
    component.fixture.chat.scenario('history', 101);
  });
  await capture.component('ex-machine-workspace', component => {
    component.store.selectSession({ taskId: '11', sessionId: '101' });
  });
  await capture.waitFor(() => {
    const viewport = document.querySelector('ex-chat-scroll .viewport');
    return viewport && viewport.scrollHeight > viewport.clientHeight &&
      viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop < 1;
  });

  for (const theme of ['light', 'dark']) {
    await capture.theme(theme);
    for (const reduced of [false, true]) {
      await capture.viewport(reduced ? 1000 : 1440, reduced ? 760 : 960);
      await capture.reducedMotion(reduced);
      await capture.component('ex-chat-scroll', component => component.scrollToEnd('instant'));
      const name = `${theme}-${reduced ? 'narrow-reduced' : 'full'}`;
      assert.equal(await capture.evaluate(() => document.querySelector('ex-chat-scroll .return').inert), true);
      if (!reduced) await capture.motion.freeze();
      await capture.evaluate(() => {
        const viewport = document.querySelector('ex-chat-scroll .viewport');
        viewport.scrollTop -= 600;
        viewport.dispatchEvent(new window.Event('scroll'));
      });
      await capture.waitFor(() => document.querySelector('ex-chat-scroll .return.visible'));
      if (!reduced) {
        // Seek only this surface: timer-driven sidebar animation IDs can retire
        // while the global animation clock is paused.
        for (const age of [0, 100, 280]) {
          await capture.evaluate(age => {
            for (const animation of document.querySelector('ex-chat-scroll .return').getAnimations())
              animation.currentTime = age;
          }, age);
          await capture.settle();
          yield { name: `${name}-enter-${age}ms`, inspect: ['ex-chat-scroll .return'] };
        }
        await capture.motion.finish();
        await capture.motion.play();
      }
      yield { name: `${name}-reading`, inspect: ['ex-chat-scroll .return', 'ex-composer'] };
      assert.equal(await capture.evaluate(() => document.querySelector('ex-chat-scroll .return').inert), false);
      assert.match(await capture.evaluate(() => document.querySelector('ex-chat-scroll .return-button').textContent), /Scroll to bottom/);

      // Native Enter activates the same return action as pointer input.
      await capture.evaluate(() => document.querySelector('ex-chat-scroll .return-button').focus());
      await capture.press('Enter');
      const probe = await capture.evaluate(async () => {
        const viewport = document.querySelector('ex-chat-scroll .viewport');
        const control = document.querySelector('ex-chat-scroll .return');
        const samples = [];
        for (let frame = 0; frame < 120; frame++) {
          await new Promise(requestAnimationFrame);
          const gap = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop;
          samples.push({ gap, visible: control.classList.contains('visible') });
          if (gap <= 1) break;
        }
        return { samples, focus: document.activeElement === viewport };
      });
      assert.ok(probe.samples.at(-1).gap <= 1, JSON.stringify(probe));
      assert.equal(probe.focus, true);
      if (!reduced) {
        assert.ok(probe.samples.some(sample => sample.gap > 40 && sample.gap < 590), 'Expected intermediate native smooth scroll frames');
        assert.ok(probe.samples.filter(sample => sample.gap > 40).every(sample => sample.visible), 'Return must remain visible during travel');
      }
      await capture.waitFor(() => document.querySelector('ex-chat-scroll .return').inert);
      yield { name: `${name}-returned`, metadata: { probe }, inspect: ['ex-chat-scroll .return', 'ex-chat-scroll .viewport'] };

      // Reverse the exit before it finishes. The native button keeps its identity.
      const reversal = await capture.evaluate(async () => {
        const viewport = document.querySelector('ex-chat-scroll .viewport');
        const button = document.querySelector('ex-chat-scroll .return-button');
        for (const offset of [400, 0, 400]) {
          viewport.scrollTop = viewport.scrollHeight - viewport.clientHeight - offset;
          viewport.dispatchEvent(new window.Event('scroll'));
          await new Promise(requestAnimationFrame);
        }
        return { same: button === document.querySelector('ex-chat-scroll .return-button'),
          count: document.querySelectorAll('ex-chat-scroll .return-button').length };
      });
      assert.deepEqual(reversal, { same: true, count: 1 });

      // Use the public store command and preview transport to append real messages.
      await capture.component('ex-session-chat', component => component.store.submit({
        text: 'Verify the scroll return while I read the earlier reply.', intent: 'send', context: [],
      }));
      await capture.waitFor(() => document.querySelector('ex-chat-scroll .return-button')?.textContent.includes('New messages'));
      yield { name: `${name}-unread`, inspect: ['ex-chat-scroll .return', 'ex-composer'] };
      await capture.click('ex-chat-scroll .return-button');
      await capture.waitFor(() => {
        const viewport = document.querySelector('ex-chat-scroll .viewport');
        return viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop < 1;
      });
      await capture.waitFor(() => !document.querySelector('ex-session-chat ex-composer')?.textContent.includes('Sending…'));
      await capture.waitFor(() => {
        const chat = document.querySelector('ex-session-chat');
        return window.ng.getComponent(chat).store.state()?.phase === 'idle';
      });
    }
  }
}
