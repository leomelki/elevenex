import assert from 'node:assert/strict';

/** A reply without work keeps its DOM while its live heading fades and folds. */
export default async function* (capture) {
  await capture.evaluate(() => { location.href = '/connected-workspace'; });
  await capture.waitFor(() => document.querySelector('ex-workspace-navigation ex-task-list'));
  await capture.component('ex-machine-workspace', c => c.store.selectSession({ taskId: '11', sessionId: '101' }));
  const state = running => capture.component('ex-connected-workspace-demo', (c, running) => c.fixture.chat.scenario(running ? 'reply-only-running' : 'reply-only'), running);
  const finish = async () => {
    await capture.settle();
    await capture.waitFor(() => document.getAnimations().every(a => !Number.isFinite(a.effect?.getComputedTiming().endTime) || a.playState !== 'running'));
  };
  const inspect = ['ex-turn .work-region', 'ex-turn .work-row', 'ex-turn .answer'];
  const geometry = () => capture.evaluate(() => {
    const turn = document.querySelector('ex-turn');
    const header = turn.querySelector('.work-region');
    const answer = turn.querySelector('.answer');
    return {
      height: header.getBoundingClientRect().height,
      answer: answer.getBoundingClientRect().top - turn.getBoundingClientRect().top,
      opacity: Number(getComputedStyle(header.querySelector('.content')).opacity),
      inert: header.inert, label: header.textContent.trim(),
      count: turn.querySelectorAll('.work-row').length,
    };
  });
  const seek = async age => {
    await capture.evaluate(age => {
      for (const animation of document.querySelector('ex-turn .body').getAnimations({ subtree: true })) {
        if (Number.isFinite(animation.effect?.getComputedTiming().endTime)) animation.currentTime = age;
      }
    }, age);
    await capture.settle();
  };
  for (const theme of ['light', 'dark']) {
    await capture.theme(theme); await capture.viewport(1440, 960); await capture.reducedMotion(false);
    await state(true); await capture.waitFor(() => document.querySelector('ex-turn.live .work-region.open')); await finish();
    await capture.fill('ex-composer textarea', 'Keep this draft while the answer finishes.');
    const start = await geometry();
    assert.equal(start.height, 36);
    await capture.motion.freeze(); await state(false);
    await capture.waitFor(() => document.querySelector('ex-turn .work-region[inert]'));
    const frames = [];
    for (const age of [0, 80, 160, 280]) {
      await seek(age);
      const frame = await geometry(); frames.push(frame);
      assert.equal(frame.inert, true);
      assert.equal(frame.label.includes('Worked'), false);
      assert.equal(frame.count, 1);
      yield { name: `${theme}-completion-${age}ms`, inspect, metadata: { frame } };
    }
    assert.ok(Math.abs(frames[0].answer - start.answer) < 1, 'No first-frame answer jump');
    assert.ok(frames[1].height > 0 && frames[1].height < start.height);
    assert.ok(frames[1].opacity > 0 && frames[1].opacity < 1);
    assert.ok(frames[2].height < frames[1].height);
    assert.equal(frames[3].height, 0);
    assert.equal(frames[3].answer, 0);
    assert.equal(await capture.evaluate(() => document.activeElement?.matches('ex-composer textarea')), true);
    assert.equal(await capture.evaluate(() => document.querySelector('ex-composer textarea').value), 'Keep this draft while the answer finishes.');
    await capture.motion.finish(); await capture.motion.play(); await finish();

    // Real-time samples measure movement and preserve both reply and heading identity.
    await state(true); await capture.waitFor(() => document.querySelector('ex-turn.live')); await finish();
    const probe = await capture.component('ex-connected-workspace-demo', async c => {
      const turn = document.querySelector('ex-turn'), answer = turn.querySelector('.answer');
      const header = turn.querySelector('.work-region'), row = header.querySelector('.work-row');
      const samples = [];
      const sample = () => ({ time: performance.now(), height: header.getBoundingClientRect().height,
        answer: answer.getBoundingClientRect().top - turn.getBoundingClientRect().top });
      samples.push(sample()); c.fixture.chat.scenario('reply-only');
      for (let i = 0; i < 90; i++) {
        await new Promise(requestAnimationFrame); samples.push(sample());
        if (header.inert && samples.at(-1).height === 0) break;
      }
      return { samples, sameAnswer: answer === document.querySelector('ex-turn .answer'),
        sameHeader: row === document.querySelector('ex-turn .work-row') };
    });
    assert.equal(probe.sameAnswer, true); assert.equal(probe.sameHeader, true);
    assert.equal(probe.samples.at(-1).height, 0);
    assert.ok(probe.samples.some(s => s.height > 1 && s.height < 35));
    for (let i = 1; i < probe.samples.length; i++) {
      const a = probe.samples[i - 1], b = probe.samples[i];
      assert.ok(Math.abs(b.answer - a.answer) < Math.max(7, (b.time - a.time) * .6), 'Unexpected answer jump: ' + JSON.stringify({ a, b }));
    }
    yield { name: `${theme}-natural-completion`, inspect, metadata: { probe } };

    // Reverse an exit on the same retained row, without remounting its controls.
    await state(true); await capture.waitFor(() => document.querySelector('ex-turn.live')); await finish();
    await capture.evaluate(() => { document.querySelector('ex-turn .work-row').dataset.identity = 'retained'; });
    await capture.motion.freeze(); await state(false);
    await capture.waitFor(() => document.querySelector('ex-turn .work-region[inert]')); await seek(80);
    const before = await geometry();
    await state(true); await capture.waitFor(() => document.querySelector('ex-turn.live .work-region.open'));
    const after = await geometry();
    assert.ok(Math.abs(after.height - before.height) < 1, 'Interrupted reopening must preserve the painted height');
    assert.equal(after.count, 1);
    assert.equal(await capture.evaluate(() => document.querySelector('ex-turn .work-row').dataset.identity), 'retained');
    yield { name: `${theme}-interrupted-reopen`, inspect, metadata: { before, after } };
    await capture.motion.finish(); await capture.motion.play(); await finish();

    await capture.viewport(1000, 760); await capture.reducedMotion(true); await finish();
    await capture.evaluate(() => document.querySelector('ex-turn .work-row button[exButton]').focus());
    await state(false); await capture.waitFor(() => !document.querySelector('ex-turn.live')); await finish();
    assert.equal((await geometry()).height, 0);
    assert.equal(await capture.evaluate(() => document.activeElement === document.querySelector('ex-turn')), true);
    yield { name: `${theme}-narrow-reduced`, inspect };

    // Use the real submit/stream/receipt path, with the durable prompt arriving
    // in the same update as completion instead of toggling a preloaded turn.
    await capture.viewport(1440, 960); await capture.reducedMotion(false);
    await state(false); await finish();
    await capture.component('ex-connected-workspace-demo', c => c.fixture.chat.deferUserReceipts('completion'));
    await capture.fill('ex-composer textarea', 'Reply without tools'); await capture.press('Enter');
    await capture.waitFor(() => document.querySelectorAll('ex-turn').length === 2 && document.querySelector('ex-turn:last-of-type.live'));
    const receiptProbe = await capture.component('ex-session-chat', async c => {
      const turn = document.querySelector('ex-turn:last-of-type'), answer = turn.querySelector('.answer');
      const header = turn.querySelector('.work-region');
      const beforeId = c.store.exchanges().at(-1).id;
      const samples = [];
      for (let i = 0; i < 240; i++) {
        await new Promise(requestAnimationFrame);
        const current = document.querySelector('ex-turn:last-of-type');
        samples.push({ time: performance.now(), sameTurn: current === turn,
          height: current.querySelector('.work-region').getBoundingClientRect().height,
          live: current.classList.contains('live') });
        if (!samples.at(-1).live && samples.at(-1).height === 0) break;
      }
      return { samples: samples.slice(-40), beforeId, afterId: c.store.exchanges().at(-1).id,
        sameAnswer: answer === document.querySelector('ex-turn:last-of-type .answer'),
        inert: header.inert };
    });
    assert.notEqual(receiptProbe.beforeId, receiptProbe.afterId, 'Exercise optimistic to durable receipt replacement');
    assert.ok(receiptProbe.samples.every(sample => sample.sameTurn), 'Receipt replaced the animated turn');
    assert.equal(receiptProbe.sameAnswer, true);
    assert.ok(receiptProbe.samples.some(sample => !sample.live && sample.height > 0 && sample.height < 36), 'Completion must have visible collapse frames');
    assert.equal(receiptProbe.samples.at(-1).height, 0);
    assert.equal(receiptProbe.inert, true);
    yield { name: `${theme}-late-receipt-completion`, inspect, metadata: { receiptProbe } };
    await capture.component('ex-connected-workspace-demo', c => c.fixture.chat.deferUserReceipts(false));
  }
}
