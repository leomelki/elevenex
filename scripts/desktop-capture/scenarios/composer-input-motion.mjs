import assert from 'node:assert/strict';

const textarea = 'ex-composer textarea';
const inspect = ['ex-composer', textarea, 'ex-composer .input-height'];

async function measure(capture) {
  return capture.evaluate(() => {
    const input = document.querySelector('ex-composer textarea');
    const wrapper = input.closest('.input-height');
    const rect = input.getBoundingClientRect();
    const box = wrapper.getBoundingClientRect();
    return {
      top: rect.top, height: rect.height, boxTop: box.top, boxHeight: box.height,
      scroll: input.scrollTop, boxScroll: wrapper.scrollTop,
      focused: document.activeElement === input,
      value: input.value, selection: input.selectionStart,
      moving: wrapper.getAnimations().some(animation =>
        animation.effect.getKeyframes().some(frame => frame.height !== undefined)),
    };
  });
}

function aligned(point) {
  assert.ok(Math.abs(point.top - point.boxTop) < 1,
    `Text must follow the animated box: ${JSON.stringify(point)}`);
  assert.equal(point.scroll, 0, 'Uncapped drafts must not scroll internally');
  assert.equal(point.boxScroll, 0, 'Animation must not scroll its wrapper');
  assert.equal(point.focused, true, 'Editing must keep keyboard focus');
}

async function seekHeight(capture, age) {
  // Scrub only the height effect: completed chat/status effects can disappear
  // while Chromium's global animation event list is being inspected.
  await capture.evaluate(age => {
    const wrapper = document.querySelector('ex-composer .input-height');
    const animation = wrapper.getAnimations().find(animation =>
      animation.effect.getKeyframes().some(frame => frame.height !== undefined));
    if (!animation) throw new Error('Missing composer height animation');
    animation.currentTime = age;
  }, age);
  await capture.settle();
}

async function sample(capture, before) {
  const points = [];
  for (const age of [0, 45, 100, 199]) {
    await seekHeight(capture, age);
    const point = await measure(capture);
    aligned(point);
    if (age === 0) assert.ok(Math.abs(point.top - before.top) < 1,
      `Text must not jump before the box starts moving: ${JSON.stringify({ before, point })}`);
    points.push({ age, ...point });
  }
  await capture.motion.finish();
  await capture.settle();
  const settled = await measure(capture);
  aligned(settled);
  assert.equal(settled.moving, false);
  assert.ok(Math.abs(points.at(-1).top - settled.top) < 1, 'Text must not jump when the animation releases its height');
  return { points, settled };
}

/** Trusted multiline edits through the connected production chat composition. */
export default async function* (capture) {
  await capture.evaluate(() => { location.href = '/connected-workspace'; });
  await capture.waitFor(() => document.querySelector('ex-workspace-navigation ex-task-list'));
  await capture.component('ex-machine-workspace', component => component.store.selectSession({ taskId: '11', sessionId: '101' }));
  await capture.waitFor(() => document.querySelector('ex-composer textarea'));
  for (const theme of ['light', 'dark']) {
    await capture.theme(theme);
    await capture.viewport(1440, 960);
    await capture.reducedMotion(false);
    await capture.motion.play();
    await capture.fill(textarea, 'First line\nSecond line');
    await capture.motion.finish(); await capture.settle();
    const before = await measure(capture);
    await capture.motion.freeze();
    await capture.press('Enter', 8);
    const growth = await sample(capture, before);
    assert.equal(growth.settled.value, 'First line\nSecond line\n');
    assert.ok(growth.settled.boxHeight > before.boxHeight);
    yield { name: `${theme}-newline`, inspect, metadata: growth };

    // Another edit starts from the currently painted height, even mid-growth.
    await capture.press('Enter', 8);
    await seekHeight(capture, 45);
    const interrupted = await measure(capture);
    yield { name: `${theme}-growing`, inspect, metadata: interrupted };
    await capture.press('Enter', 8);
    const repeated = await sample(capture, interrupted);
    assert.equal(repeated.settled.value, 'First line\nSecond line\n\n\n');
    yield { name: `${theme}-rapid-newlines`, inspect, metadata: repeated };

    for (const type of ['keyDown', 'keyUp']) {
      await capture.cdp('Input.dispatchKeyEvent', { type, key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    }
    await capture.settle();
    const shrinking = await sample(capture, repeated.settled);
    assert.equal(shrinking.settled.value, 'First line\nSecond line\n\n');
    assert.ok(shrinking.settled.boxHeight < repeated.settled.boxHeight);
    yield { name: `${theme}-shrink`, inspect, metadata: shrinking };

    // Exercise the textarea's own scrolling separately from wrapper motion.
    await capture.motion.play();
    await capture.fill(textarea, Array.from({ length: 18 }, (_, i) => `Line ${i + 1}`).join('\n'));
    await capture.motion.finish(); await capture.settle();
    await capture.press('Enter', 8);
    await capture.settle();
    const capped = await measure(capture);
    assert.equal(capped.height, 240);
    assert.ok(capped.scroll > 0, 'Long drafts keep native caret scrolling');
    assert.equal(capped.focused, true);
    yield { name: `${theme}-scrolling`, inspect, metadata: capped };

    await capture.reducedMotion(true);
    await capture.viewport(980, 680);
    await capture.fill(textarea, 'First line\nSecond line');
    await capture.settle();
    await capture.press('Enter', 8);
    await capture.settle();
    const reduced = await measure(capture);
    aligned(reduced);
    assert.equal(reduced.moving, false, 'Reduced motion settles immediately');
    assert.equal(reduced.value, 'First line\nSecond line\n');
    yield { name: `${theme}-narrow-reduced`, inspect, metadata: reduced };
  }
}
