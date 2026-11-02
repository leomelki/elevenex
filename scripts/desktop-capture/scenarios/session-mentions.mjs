import assert from 'node:assert/strict';

/** Real sidebar transfer data and trusted Chromium drops exercise the connected composer. */
export default async function* (capture) {
  await capture.evaluate(() => { location.href = '/connected-workspace'; });
  await capture.waitFor(() => document.querySelector('ex-workspace-navigation ex-task-list'));
  const owner = (fn, data) => capture.component('ex-machine-workspace', fn, data);
  const source = '[data-session-id="102"] .select';
  const textarea = 'ex-composer textarea';
  await owner(component => component.store.selectSession({ taskId: '11', sessionId: '101' }));
  await capture.waitFor(() => document.querySelector('ex-composer textarea'));

  async function startDrag() {
    const items = await capture.evaluate(selector => {
      const element = document.querySelector(selector);
      element.scrollIntoView({ block: 'nearest' });
      const dataTransfer = new window.DataTransfer();
      element.dispatchEvent(new window.DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer }));
      return Array.from(dataTransfer.types).map(mimeType => ({ mimeType, data: dataTransfer.getData(mimeType) }));
    }, source);
    assert.equal(items[0].mimeType, 'application/x-elevenex-desktop-session');
    const target = await capture.evaluate(selector => {
      const rect = document.querySelector(selector).getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    }, textarea);
    const data = { items, dragOperationsMask: 1 };
    await capture.cdp('Input.dispatchDragEvent', { type: 'dragEnter', ...target, data });
    await capture.cdp('Input.dispatchDragEvent', { type: 'dragOver', ...target, data });
    return { target, data };
  }
  async function drop({ target, data }) {
    await capture.cdp('Input.dispatchDragEvent', { type: 'drop', ...target, data });
    await capture.evaluate(selector => document.querySelector(selector).dispatchEvent(new window.DragEvent('dragend', { bubbles: true })), source);
  }
  async function settleComposer() {
    await capture.settle();
    await capture.waitFor(() => document.querySelector('ex-composer').getAnimations({ subtree: true })
      .every(animation => !Number.isFinite(animation.effect?.getComputedTiming().endTime) || animation.playState !== 'running'));
  }
  for (const theme of ['light', 'dark']) {
    await capture.viewport(1440, 960); await capture.theme(theme);
    await capture.component('ex-connected-workspace-demo', component => component.fixture.chat.scenario('ready'));
    await capture.waitFor(() => !document.querySelector('ex-composer button.send')?.disabled || !!document.querySelector('ex-session-chat .provider'));
    await capture.fill(textarea, 'Compare with ');
    const drag = await startDrag();
    await capture.waitFor(() => document.querySelector('ex-composer .drop-label.visible'));
    await capture.evaluate(() => {
      for (const animation of document.querySelector('ex-composer .drop-label').getAnimations()) { animation.pause(); animation.currentTime = 80; }
    });
    yield { name: `${theme}-drop-arriving`, inspect: ['ex-composer .drop-label', source] };
    await capture.evaluate(() => { for (const animation of document.querySelector('ex-composer .drop-label').getAnimations()) animation.finish(); });
    yield { name: `${theme}-drop-ready`, inspect: ['ex-composer', 'ex-composer .drop-label'] };
    await drop(drag);
    await capture.settle();
    assert.equal(await capture.evaluate(() => document.querySelectorAll('ex-composer .context ex-mention').length), 1);
    assert.equal(await capture.evaluate(() => document.activeElement === document.querySelector('ex-composer textarea')), true);
    const text = await capture.evaluate(() => document.querySelector('ex-composer textarea').value);
    assert.equal(text, 'Compare with ');
    yield { name: `${theme}-mentioned`, inspect: ['ex-composer', 'ex-composer .context'] };

    await drop(await startDrag()); await capture.settle();
    assert.equal(await capture.evaluate(() => document.querySelector('ex-composer textarea').value), text);
    assert.equal(await capture.evaluate(() => document.querySelectorAll('ex-composer .context ex-mention').length), 1);
    await owner(component => component.store.selectSession({ taskId: '11', sessionId: '102' }));
    await capture.waitFor(() => document.querySelector('ex-composer textarea')?.value === '');
    await owner(component => component.store.selectSession({ taskId: '11', sessionId: '101' }));
    await capture.waitFor(value => document.querySelector('ex-composer textarea')?.value === value, text);
    assert.equal(await capture.evaluate(() => document.querySelectorAll('ex-composer .context ex-mention').length), 1);

    await settleComposer();
    await capture.click('ex-composer .context ex-mention button');
    await capture.waitFor(() => !document.querySelector('ex-composer .context'));
    assert.equal(await capture.evaluate(() => document.querySelector('ex-composer textarea').value), text);
    await capture.fill(textarea, '@'); await capture.press('ArrowDown'); await capture.press('Enter');
    await capture.waitFor(() => document.querySelector('ex-composer .context ex-mention'));
    assert.equal(await capture.evaluate(() => document.querySelector('ex-composer textarea').value), '');
    yield { name: `${theme}-keyboard-mentioned`, inspect: ['ex-composer'] };
    await capture.viewport(940, 640); await capture.reducedMotion(true);
    yield { name: `${theme}-narrow-reduced`, inspect: ['ex-composer', 'ex-composer .context'] };
    await capture.click('ex-composer .context ex-mention button'); await capture.fill(textarea, '');
    await capture.component('ex-composer', component => component.insertMention({ id: '999', kind: 'session', label: 'A very long session title '.repeat(30) }));
    assert.equal(await capture.evaluate(() => {
      const context = document.querySelector('ex-composer .context');
      return context.scrollWidth <= context.clientWidth;
    }), true);
    yield { name: `${theme}-long-mention`, inspect: ['ex-composer .context', 'ex-composer ex-mention .label', 'ex-composer ex-mention button'] };
    await capture.click('ex-composer .context ex-mention button'); await capture.fill(textarea, '');
    await capture.reducedMotion(false);
    await capture.viewport(1440, 960);
    await drop(await startDrag());
    await capture.fill(textarea, 'Compare the attached session'); await capture.press('Enter');
    await capture.waitFor(() => document.querySelector('ex-message[data-user-message^="sent-"] [aria-label="Mentioned sessions"] ex-mention'));
    assert.equal(await capture.evaluate(() => document.querySelector('ex-composer .context')), null);
    assert.equal(await capture.evaluate(() => !!document.querySelector('ex-message [aria-label="Mentioned sessions"] button')), false);
    yield { name: `${theme}-sent-mention`, inspect: ['ex-message[data-user-message^="sent-"]', 'ex-composer'] };
    await owner(component => component.store.selectSession({ taskId: '11', sessionId: '102' }));
    await capture.waitFor(() => !document.querySelector('ex-message[data-user-message^="sent-"]'));
    await owner(component => component.store.selectSession({ taskId: '11', sessionId: '101' }));
    await capture.waitFor(() => document.querySelector('ex-message[data-user-message^="sent-"] [aria-label="Mentioned sessions"]')?.textContent.includes('Review the race condition'));
    yield { name: `${theme}-reopened-mention`, inspect: ['ex-message[data-user-message^="sent-"]'] };
  }
}
