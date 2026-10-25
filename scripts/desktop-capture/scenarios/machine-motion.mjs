import assert from 'node:assert/strict';

// Focused geometry/reversal checks against the real preview, without preparation timers.
export default async function* (capture) {
  await capture.evaluate(() => { location.href = '/machine-flow'; });
  await capture.waitFor(() => !!document.querySelector('ex-machine-flow-demo'));
  const owner = (fn, data) => capture.component('ex-machine-flow-demo', fn, data);
  const seek = (selector, time) => capture.evaluate((selector, time) => {
    for (const animation of document.querySelector(selector).getAnimations({ subtree: true })) if (Number.isFinite(animation.effect?.getComputedTiming().endTime)) animation.currentTime = time;
  }, selector, time);
  const settled = () => capture.evaluate(async () => {
    await Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => undefined)));
  });
  const pose = () => capture.evaluate(() => {
    const pane = document.querySelector('.launch > .pane'), zoom = pane.firstElementChild;
    const matrix = new window.DOMMatrixReadOnly(getComputedStyle(zoom).transform);
    return { clip: getComputedStyle(pane).clipPath.match(/-?[\d.]+/g)?.slice(0, 4).map(Number) ?? [], x: matrix.e, y: matrix.f, scaleX: matrix.a, scaleY: matrix.d };
  });
  const sameClip = (a, b) => { assert.equal(a.clip.length, 4); assert.equal(b.clip.length, 4); a.clip.forEach((value, i) => assert.ok(Math.abs(value - b.clip[i]) < 1, 'Pane resumes from its painted clip')); };
  for (const theme of ['light', 'dark']) {
    await capture.theme(theme); await capture.reducedMotion(false);
    await owner(component => component.reset(false)); await settled();
    const origin = await capture.evaluate(() => {
      const card = document.querySelector('[data-machine="local"]').getBoundingClientRect();
      return { x: card.x, y: card.y, width: card.width, height: card.height };
    });
    await capture.motion.freeze(); await capture.click('[data-machine="local"]');
    await capture.waitFor(() => document.querySelector('.launch .faces').children.length > 0);
    await seek('.launch', 0); await capture.settle();
    const face = await capture.evaluate(() => {
      const rect = document.querySelector('.launch .faces > *').getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    });
    for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(face[key] - origin[key]) < 1, 'The visible card is the launch origin');
    yield { name: `${theme}-launch-start`, inspect: ['.launch > .pane', '.launch .faces > *'], metadata: { origin, face } };
    await seek('.launch', 180); await capture.settle();
    const before = await pose(); assert.ok(Math.abs(before.scaleX - before.scaleY) < .0001, 'The view never stretches');
    yield { name: `${theme}-launch-moving`, metadata: { pose: before } };
    await owner(component => component.opened.set(false)); await seek('.launch', 0); await capture.settle();
    const reversed = await pose(); sameClip(before, reversed);
    yield { name: `${theme}-launch-reversed`, metadata: { before, reversed } };
    await seek('.launch', 100); const closing = await pose();
    await owner(component => component.opened.set(true)); await seek('.launch', 0); await capture.settle();
    const reopened = await pose(); sameClip(closing, reopened);
    yield { name: `${theme}-launch-reopened`, metadata: { closing, reopened } };
    await capture.motion.play(); await capture.waitFor(() => !document.querySelector('.launch .faces').children.length);
    await owner(component => component.reset(true)); await settled();
    const trigger = await capture.evaluate(() => {
      const rect = document.querySelector('ex-machine-add[kind="ssh"] button').getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    });
    await capture.motion.freeze(); await capture.click('ex-machine-add[kind="ssh"] button');
    await capture.waitFor(() => !!document.querySelector('.ex-modal-has-from'));
    await seek('.ex-modal-layer', 0); await capture.settle();
    const anchor = await capture.evaluate(() => {
      const surface = document.querySelector('ex-add-machine'), face = document.querySelector('.ex-modal-face');
      const matrix = new window.DOMMatrixReadOnly(getComputedStyle(surface).transform);
      const rect = face.getBoundingClientRect();
      return { scaleX: matrix.a, scaleY: matrix.d, x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    });
    assert.ok(Math.abs(anchor.scaleX - anchor.scaleY) < .0001, 'The dialog uses uniform cover-fit scaling');
    for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(anchor[key] - trigger[key]) < 1, 'The face starts on the actual trigger');
    yield { name: `${theme}-modal-origin`, inspect: ['ex-add-machine', '.ex-modal-face', '.ex-modal-shadow'], metadata: { anchor, trigger } };
    await seek('.ex-modal-layer', 85); await capture.settle();
    const modalPose = () => capture.evaluate(() => {
      const surface = document.querySelector('ex-add-machine');
      const nodes = [surface, ...surface.children, document.querySelector('.ex-modal-face'), document.querySelector('.ex-modal-shadow')];
      return nodes.map(node => {
        const style = getComputedStyle(node);
        return [...new window.DOMMatrixReadOnly(style.transform).toFloat64Array(), Number(style.opacity)];
      });
    });
    const sameModal = (before, after) => before.forEach((node, index) => node.forEach((value, key) => assert.ok(Math.abs(value - after[index][key]) < .005, 'Every modal layer resumes its painted frame')));
    const modalBefore = await modalPose();
    await owner(component => component.closeDialog()); await seek('.ex-modal-layer', 0); await capture.settle();
    const modalAfter = await modalPose(); sameModal(modalBefore, modalAfter);
    yield { name: `${theme}-modal-reversed`, metadata: { modalBefore, modalAfter } };
    await seek('.ex-modal-layer', 90); const modalClosing = await modalPose();
    await owner(component => component.dialogOpen.set(true)); await seek('.ex-modal-layer', 0); await capture.settle();
    const modalReopened = await modalPose(); sameModal(modalClosing, modalReopened);
    yield { name: `${theme}-modal-reopened`, metadata: { modalClosing, modalReopened } };
    await capture.motion.play(); await settled();
    await capture.evaluate(() => document.querySelector('ex-host-field input').focus());
    assert.equal(await capture.evaluate(() => document.activeElement === document.querySelector('ex-host-field input')), true);
    await capture.press('Escape'); await capture.waitFor(() => !document.querySelector('.ex-modal-layer'));
    assert.equal(await capture.evaluate(() => document.activeElement.closest('ex-machine-add') !== null), true);
    yield { name: `${theme}-modal-restored-focus` };
  }
}
