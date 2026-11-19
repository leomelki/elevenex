import assert from 'node:assert/strict';

export default async function* (capture) {
  const demo = (fn) => capture.component('ex-connected-workspace-demo', fn);
  const chat = (fn) => capture.component('ex-session-chat', fn);
  const holdPage = async (direction) => {
    await demo(owner => owner.fixture.chat.holdReads(true));
    const distance = direction === 'before' ? -120 : 120;
    const point = await capture.evaluate(direction => {
      const viewport = document.querySelector('ex-chat-scroll .viewport');
      viewport.scrollTop = direction === 'before' ? 300 : viewport.scrollHeight - viewport.clientHeight - 300;
      const r = viewport.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, direction);
    await capture.cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: 0, deltaY: distance });
    await capture.waitFor(direction => {
      const owner = window.ng.getComponent(document.querySelector('ex-session-chat'));
      const viewport = document.querySelector('ex-chat-scroll .viewport');
      const gap = direction === 'before' ? viewport.scrollTop : viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop;
      return owner.store.historyLoading() && Math.abs(gap - 180) < 1;
    }, direction);
    await capture.settle();
    return point;
  };
  const measurePage = async () => {
    const samples = await demo(async owner => {
      const viewport = document.querySelector('ex-chat-scroll .viewport');
      const composer = document.querySelector('ex-composer');
      const bounds = viewport.getBoundingClientRect();
      const row = [...viewport.querySelectorAll('[data-chat-row]')].find(el =>
        el.getBoundingClientRect().top > bounds.top && el.getBoundingClientRect().top < bounds.bottom);
      const sample = () => ({
        row: row.getBoundingClientRect().top - bounds.top, connected: row.isConnected,
        width: viewport.clientWidth, composerTop: composer.getBoundingClientRect().top,
        thumb: viewport.scrollTop / viewport.scrollHeight * bounds.height,
        thumbEnd: (viewport.scrollTop + viewport.clientHeight) / viewport.scrollHeight * bounds.height,
      });
      const frames = [sample()];
      owner.fixture.chat.holdReads(false);
      for (let i = 0; i < 42; i++) {
        await new Promise(requestAnimationFrame);
        frames.push(sample());
      }
      return frames;
    });
    const rowShift = Math.max(...samples.map(sample => Math.abs(sample.row - samples[0].row)));
    const thumbJump = Math.max(...samples.slice(1).map((sample, i) =>
      Math.max(Math.abs(sample.thumb - samples[i].thumb), Math.abs(sample.thumbEnd - samples[i].thumbEnd))));
    assert.ok(samples.every(sample => sample.connected) && rowShift <= 1, `Visible reply moved ${rowShift}px`);
    assert.ok(samples.every(sample => sample.width === samples[0].width && sample.composerTop === samples[0].composerTop),
      'Paging changed the reading width or composer position');
    assert.ok(thumbJump <= 25, `Scrollbar thumb jumped ${thumbJump}px in one frame`);
    assert.equal(await capture.evaluate(() => !!document.querySelector('.viewport.reconciling-history')), false,
      'The scroll range did not settle');
    return { rowShift, thumbJump, samples };
  };

  for (const theme of ['light', 'dark']) {
    await capture.evaluate(() => { location.href = '/connected-workspace'; });
    await capture.waitFor(() => document.querySelector('ex-machine-workspace ex-task-list'));
    await capture.theme(theme);
    await capture.viewport(theme === 'light' ? 1440 : 1000, 900);
    await capture.reducedMotion(theme === 'dark');
    await demo(async owner => {
      owner.fixture.chat.scenario('new', 101);
      const result = await owner.fixture.chat.read({ taskId: 11, sessionId: 101, requestId: window.crypto.randomUUID() });
      const base = { timestamp: '2026-11-17T10:00:00Z', toolId: null, toolName: null, toolKind: null, input: '', error: false, truncated: false };
      owner.fixture.chat.seed(101, { state: result.value.state, items: Array.from({ length: 250 }, (_, i) => [
        { ...base, id: 'prompt-' + i, kind: 'user', text: 'Request ' + i },
        { ...base, id: 'answer-' + i, kind: 'assistant', text: ('Reply ' + i + '. This answer stays in place as the conversation window changes.\n\n').repeat(i % 8 + 1) },
      ]).flat() });
    });
    await capture.component('ex-machine-workspace', owner => owner.store.selectSession({ taskId: '11', sessionId: '101' }));
    await capture.waitFor(() => document.querySelector('[data-chat-row="answer-249"]'));

    await holdPage('before');
    await capture.evaluate(() => document.querySelector('ex-chat-scroll .viewport').focus({ preventScroll: true }));
    await capture.press('End');
    await capture.waitFor(() => {
      const viewport = document.querySelector('ex-chat-scroll .viewport');
      const owner = window.ng.getComponent(document.querySelector('ex-session-chat'));
      return !owner.store.historyLoading() && viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop < 1;
    });
    await demo(owner => owner.fixture.chat.holdReads(false));
    assert.equal(await chat(owner => owner.store.items().at(-1)?.id), 'answer-249', 'A stalled page evicted the reply after End');
    assert.equal(await chat(owner => owner.store.next()), null, 'A cancelled page replaced the live edge');

    await holdPage('before');
    const older = await measurePage();
    assert.equal(await chat(owner => !!owner.store.next()), true, 'The older page must evict the live edge');
    yield { name: theme + '-older-page', inspect: ['ex-chat-scroll .viewport', 'ex-composer'], metadata: older };

    await holdPage('following');
    const following = await measurePage();
    assert.equal(await chat(owner => owner.store.next()), null, 'Following must restore the live edge');
    yield { name: theme + '-following-page', inspect: ['ex-chat-scroll .viewport', 'ex-composer'], metadata: following };

    const point = await holdPage('before');
    const anchor = await capture.evaluate(() => {
      const viewport = document.querySelector('ex-chat-scroll .viewport');
      const bounds = viewport.getBoundingClientRect();
      const row = [...viewport.querySelectorAll('[data-chat-row]')].find(el =>
        el.getBoundingClientRect().top > bounds.top && el.getBoundingClientRect().top < bounds.bottom);
      window.ng.getComponent(document.querySelector('ex-connected-workspace-demo')).fixture.chat.holdReads(false);
      return { id: row.getAttribute('data-chat-row'), top: row.getBoundingClientRect().top };
    });
    await capture.waitFor(() => document.querySelector('.viewport.reconciling-history'));
    await capture.cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: 0, deltaY: -60 });
    await capture.waitFor(() => !document.querySelector('.viewport.reconciling-history'));
    await capture.settle();
    const top = await capture.evaluate(id => document.querySelector(`[data-chat-row="${id}"]`).getBoundingClientRect().top, anchor.id);
    assert.ok(Math.abs(top - anchor.top - 60) <= 1, `The second wheel gesture moved the reply ${top - anchor.top}px instead of 60px`);
  }
}
