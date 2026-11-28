import assert from 'node:assert/strict';

/** The live reply follows the send on one mount, including early receipts. */
export default async function* (capture) {
  await capture.evaluate(() => { location.href = '/connected-workspace'; });
  await capture.waitFor(() => document.querySelector('ex-workspace-navigation ex-task-list'));
  await capture.component('ex-machine-workspace', c => c.store.selectSession({ taskId: '11', sessionId: '101' }));
  const finish = async () => {
    await capture.evaluate(() => {
      for (const animation of document.getAnimations())
        if (Number.isFinite(animation.effect?.getComputedTiming().endTime)) animation.finish();
    });
    await capture.motion.play(); await capture.settle();
  };
  const reset = async () => {
    await finish();
    await capture.component('ex-connected-workspace-demo', c => {
      c.fixture.chat.scenario('reply-only'); c.fixture.chat.deferUserReceipts(false);
    });
    await capture.waitFor(() => document.querySelectorAll('ex-turn').length === 1 && !document.querySelector('ex-turn.live'));
    await finish();
  };
  const seek = async age => {
    await capture.evaluate(age => {
      for (const animation of document.getAnimations())
        if (Number.isFinite(animation.effect?.getComputedTiming().endTime)) animation.currentTime = age;
    }, age);
    await capture.settle();
  };
  const geometry = () => capture.evaluate(() => {
    const turn = document.querySelector('ex-turn:last-of-type');
    const message = document.querySelector('ex-message:last-of-type');
    const mark = turn.querySelector('.mark');
    const style = getComputedStyle(turn), markStyle = getComputedStyle(mark);
    const matrix = new window.DOMMatrixReadOnly(style.transform);
    const markMatrix = new window.DOMMatrixReadOnly(markStyle.transform);
    return { opacity: Number(style.opacity), y: matrix.m42, scale: markMatrix.a,
      turnTop: turn.getBoundingClientRect().top - matrix.m42,
      messageTop: message.getBoundingClientRect().top,
      arriving: turn.classList.contains('arriving'), working: turn.querySelector('.work-label')?.textContent.trim(),
      focus: document.activeElement.matches('ex-composer textarea'),
      id: message.id, identity: turn.dataset.identity,
      effects: turn.getAnimations().map(a => ({ duration: a.effect.getTiming().duration, delay: a.effect.getTiming().delay, frames: a.effect.getKeyframes() })) };
  });
  const inspect = ['.send-flight', 'ex-session-chat ex-message:last-of-type', 'ex-turn:last-of-type', 'ex-turn:last-of-type .work-row', 'ex-composer'];
  for (const theme of ['light', 'dark']) {
    await capture.theme(theme); await capture.viewport(1440, 960); await capture.reducedMotion(false);
    await reset();
    assert.equal(await capture.evaluate(() => document.querySelectorAll('ex-turn.arriving').length), 0, 'History stays still');
    await capture.fill('ex-composer textarea', 'Let the message and Working arrive together');
    await capture.motion.freeze(); await capture.press('Enter');
    await capture.waitFor(() => document.querySelectorAll('ex-turn').length === 2);
    await capture.evaluate(() => { document.querySelector('ex-turn:last-of-type').dataset.identity = 'retained-entry'; });
    const frames = [];
    for (const age of [0, 80, 180, 240, 340, 420]) {
      await seek(age);
      const frame = await geometry(); frames.push(frame);
      assert.equal(frame.identity, 'retained-entry');
      assert.equal(frame.focus, true);
      yield { name: `${theme}-handoff-${age}ms`, inspect, metadata: { frame } };
    }
    assert.equal(frames[0].opacity, 0, 'Working must not paint at full opacity on send');
    assert.equal(frames[0].y, 12);
    assert.equal(frames[0].working, 'Working');
    assert.ok(frames[2].opacity > 0 && frames[2].opacity < 1, 'Working fades in behind the bubble');
    assert.ok(frames[3].scale > 1 && frames[3].scale < 1.03, 'Only the small mark has a gentle spring');
    assert.equal(frames.at(-1).opacity, 1);
    assert.equal(frames.at(-1).y, 0);
    assert.equal(frames.at(-1).arriving, false);
    assert.ok(frames.every(frame => Math.abs(frame.turnTop - frames[0].turnTop) < 1), 'Reserve the final turn layout throughout entry');
    assert.ok(frames.every(frame => Math.abs(frame.messageTop - frames[0].messageTop) < 1), 'Working must not displace the landing bubble');
    await finish();

    // Completion/receipt updates cannot restart the entrance, and keyboard Stop
    // can immediately settle a still-entering row without stealing composer focus.
    await reset();
    await capture.fill('ex-composer textarea', 'Keyboard can stop this immediately');
    await capture.motion.freeze(); await capture.press('Enter'); await seek(160);
    await capture.evaluate(() => document.querySelector('ex-turn:last-of-type .work-row button[exButton]').focus());
    await capture.settle();
    assert.equal((await geometry()).arriving, false);
    assert.equal((await geometry()).opacity, 1);
    await capture.press('Enter');
    await capture.waitFor(() => !document.querySelector('ex-turn:last-of-type.live'));
    yield { name: `${theme}-keyboard-stop`, inspect };
    await finish();

    await reset();
    await capture.fill('ex-composer textarea', 'Remove this conversation during its entrance');
    await capture.motion.freeze(); await capture.press('Enter'); await seek(140);
    await capture.component('ex-machine-workspace', c => c.store.selectSession({ taskId: '11', sessionId: '102' }));
    await capture.waitFor(() => !document.querySelector('.send-flight') && !document.querySelector('ex-turn.arriving'));
    yield { name: `${theme}-interrupted-navigation`, inspect: ['ex-session-chat', 'ex-composer'] };
    await finish();
    await capture.component('ex-machine-workspace', c => c.store.selectSession({ taskId: '11', sessionId: '101' }));
    await reset();

    await capture.viewport(1000, 760); await capture.reducedMotion(true);
    await capture.fill('ex-composer textarea', 'Quiet connected send');
    await capture.motion.freeze(); await capture.press('Enter');
    await seek(80);
    const reduced = await geometry();
    assert.equal(reduced.y, 0); assert.equal(reduced.scale, 1);
    assert.ok(reduced.opacity > 0 && reduced.opacity < 1);
    assert.ok(reduced.effects.some(effect => effect.duration === 160 && effect.delay === 0 && effect.frames.every(frame => !frame.transform)));
    yield { name: `${theme}-narrow-reduced`, inspect, metadata: { reduced } };
    await seek(160); assert.equal((await geometry()).opacity, 1); await finish();
  }
}
