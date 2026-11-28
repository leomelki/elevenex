import assert from 'node:assert/strict';

const viewport = 'ex-session-chat ex-chat-scroll .viewport';
const composer = 'ex-session-chat ex-composer';
const image = viewport + ' img[alt="Verification screenshot"]';
const jump = 'ex-session-chat .return-button';
const lastLine = 'The last line of the reply remains readable.';

/** Exercise media and the floating composer through the connected preview. */
export default async function* (capture) {
  await capture.evaluate(() => { location.href = '/connected-workspace'; });
  await capture.waitFor(() => document.querySelector('ex-machine-workspace ex-task-list'));
  await capture.component('ex-connected-workspace-demo', async (owner, lastLine) => {
    const chat = owner.fixture.chat;
    const page = await chat.read({ taskId: 11, sessionId: 101, requestId: window.crypto.randomUUID() });
    if (!page.ok) throw new Error('Could not read the preview session state');
    const item = (id, kind, text, fields = {}) => ({
      id, kind, text, timestamp: '2026-11-17T10:00:00Z', toolId: null, toolName: null,
      toolKind: null, input: '', error: false, truncated: false, ...fields,
    });
    const path = '/preview/verification.png';
    chat.seed(101, { state: page.value.state, items: [
      item('seam-prompt', 'user', 'Walk through the layout and show the verification screenshot.'),
      item('seam-reply', 'assistant',
        Array.from({ length: 18 }, (_, index) => `Check ${index + 1}: review the interface at this window size.`).join('\n\n') +
        `\n\n![Verification screenshot](${path})\n\n${lastLine}`, {
          media: [{ id: '0', path, caption: 'Verification screenshot', inline: false, width: 640, height: 360 }],
        }),
    ] });
  }, lastLine);
  await capture.component('ex-machine-workspace', owner => owner.store.selectSession({ taskId: '11', sessionId: '101' }));
  await capture.waitFor(selector => document.querySelector(selector)?.naturalWidth > 0, image);

  const measure = () => capture.evaluate(({ viewport, composer, image, jump, lastLine }) => {
    const scroll = document.querySelector(viewport);
    const bounds = scroll.getBoundingClientRect();
    const dock = document.querySelector(composer).getBoundingClientRect();
    const picture = document.querySelector(image).getBoundingClientRect();
    const button = document.querySelector(jump);
    const tail = [...scroll.querySelectorAll('p')].find(p => p.textContent.trim() === lastLine);
    const line = tail.getBoundingClientRect();
    return {
      dockTop: dock.top,
      dockHeight: dock.height,
      viewportBottom: bounds.bottom,
      imageTop: picture.top,
      imageBottom: picture.bottom,
      top: scroll.scrollTop,
      endGap: scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop,
      jumpVisible: !button.closest('[inert]'),
      jumpBottom: button.getBoundingClientRect().bottom,
      viewFocused: document.activeElement === scroll,
      tailReachable: line.bottom <= bounds.bottom &&
        tail.contains(document.elementFromPoint(line.left + 2, line.top + line.height / 2)),
    };
  }, { viewport, composer, image, jump, lastLine });
  const atEnd = () => capture.waitFor(selector => {
    const scroll = document.querySelector(selector);
    return scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop <= 1;
  }, viewport);
  const assertSeam = state => {
    assert.ok(Math.abs(state.viewportBottom - state.dockTop) <= 1, JSON.stringify(state));
    if (state.jumpVisible) assert.ok(state.jumpBottom < state.dockTop, JSON.stringify(state));
  };
  const assertTail = state => {
    assertSeam(state);
    assert.ok(state.endGap <= 1 && state.tailReachable && !state.jumpVisible, JSON.stringify(state));
  };
  const edit = async (text, previousHeight, grows) => {
    await capture.fill(composer + ' textarea', text);
    await capture.waitFor(({ composer, previousHeight, grows }) => {
      const dock = document.querySelector(composer);
      const height = dock.getBoundingClientRect().height;
      return (grows ? height > previousHeight + 16 : height < previousHeight - 16) &&
        !dock.getAnimations({ subtree: true }).some(animation =>
          Number.isFinite(animation.effect.getComputedTiming().endTime) && animation.playState === 'running');
    }, { composer, previousHeight, grows });
    await capture.settle();
    return measure();
  };
  const draft = 'Keep this draft\nwhile reading the reply\nand when I return.';
  const inspect = [viewport, image, jump, composer];
  for (const { theme, width, height, reduced } of [
    { theme: 'dark', width: 1440, height: 960, reduced: false },
    { theme: 'light', width: 1440, height: 960, reduced: false },
    { theme: 'dark', width: 900, height: 700, reduced: true },
    { theme: 'light', width: 900, height: 700, reduced: true },
  ]) {
    await capture.theme(theme);
    await capture.viewport(width, height);
    await capture.reducedMotion(reduced);
    await capture.component('ex-chat-scroll', scroll => scroll.scrollToEnd('instant'));
    await atEnd();
    const initial = await measure();
    assertTail(initial);
    let state = await edit(draft, initial.dockHeight, true);
    assertTail(state);
    state = await edit('', state.dockHeight, false);
    assertTail(state);

    // Move the actual bitmap through the viewport edge using trusted wheel input.
    const box = await capture.evaluate(selector => {
      const r = document.querySelector(selector).getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, viewport);
    await capture.cdp('Input.dispatchMouseEvent', {
      type: 'mouseWheel', ...box, deltaX: 0,
      deltaY: Math.round((state.imageTop + state.imageBottom) / 2 - state.viewportBottom),
    });
    await capture.waitFor(selector => document.querySelector(selector).closest('.return').classList.contains('visible'), jump);
    await capture.waitFor(selector => document.querySelector(selector).closest('.return').getAnimations().every(
      animation => animation.playState !== 'running'), jump);
    const reading = await measure();
    assertSeam(reading);
    assert.ok(reading.imageTop < reading.viewportBottom && reading.imageBottom > reading.dockTop + 20, JSON.stringify(reading));
    const name = `${theme}-${reduced ? 'narrow-reduced' : 'wide'}`;
    yield { name: `${name}-reading-image`, inspect, metadata: reading };

    state = await edit(draft, reading.dockHeight, true);
    assertSeam(state);
    assert.ok(state.jumpVisible && Math.abs(state.imageTop - reading.imageTop) <= 1, JSON.stringify(state));
    yield { name: `${name}-expanded-composer`, inspect, metadata: state };
    state = await edit('', state.dockHeight, false);
    assert.ok(state.jumpVisible && Math.abs(state.imageTop - reading.imageTop) <= 1, JSON.stringify(state));

    await capture.evaluate(selector => document.querySelector(selector).focus(), jump);
    await capture.press('Enter');
    await atEnd();
    await capture.waitFor(selector => document.querySelector(selector).closest('.return').inert, jump);
    const returned = await measure();
    assertTail(returned);
    assert.equal(returned.viewFocused, true);
    yield { name: `${name}-at-end`, inspect, metadata: returned };
  }
}
